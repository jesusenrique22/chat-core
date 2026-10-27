/**
 * Namespace /agent — panel de agentes y jefes de departamento.
 * Autenticación obligatoria: API Key de agente o token de agente firmado (AGENT_TOKEN_SECRET).
 */

const Conversation = require('../models/Conversation');
const {
  DELIVERY_CHANNELS,
  recordMessage
} = require('../lib/messageStore');
const { validateMessagePayload } = require('../lib/messageHelpers');
const { agentSocketAuth } = require('../lib/auth');
const { registerAgentCallHandlers } = require('../lib/calls');
const { AGENTS_DASHBOARD_ROOM, getDepartmentRoom } = require('../lib/socketRooms');
const { shouldThrottleSocketEvent, shouldRateLimitSocketEvent } = require('../lib/throttle');
const { asString, asObjectId, safeAck } = require('../lib/validate');
const { publicMessage } = require('../lib/errors');
const logger = require('../lib/logger');

// Un agente atiende muchas conversaciones: límite propio, más alto que el del ciudadano
const AGENT_SEND_MESSAGE_MAX_PER_MIN = Number(process.env.AGENT_SEND_MESSAGE_MAX_PER_MIN) || 120;
const MAX_DEPARTMENT_ROOMS = 20;

function registerAgentNamespace(io) {
  const agentNamespace = io.of('/agent');
  const clientNamespace = io.of('/client');

  agentNamespace.use(agentSocketAuth);

  agentNamespace.on('connection', (socket) => {
    socket.join(AGENTS_DASHBOARD_ROOM);
    logger.info('agent_connected', { authenticated: !!socket.agent });
    registerAgentCallHandlers(socket, io);

    socket.on('agent_join', (data) => {
      const conversationId = asObjectId(data?.conversationId);
      if (!conversationId) return;

      socket.rooms.forEach((room) => {
        if (
          room !== socket.id &&
          room !== conversationId &&
          room !== AGENTS_DASHBOARD_ROOM &&
          !room.startsWith('dept-')
        ) {
          socket.leave(room);
        }
      });
      socket.join(conversationId);
      logger.debug('agent_joined_room', { conversationId });
    });

    // Unir al Jefe de Departamento a la sala de su departamento CPU
    socket.on('join_department', (data) => {
      const departmentId = asString(data?.departmentId, { max: 64 });
      if (!departmentId) return;
      const deptRooms = [...socket.rooms].filter((r) => r.startsWith('dept-'));
      if (deptRooms.length >= MAX_DEPARTMENT_ROOMS) return;

      const deptRoom = getDepartmentRoom(departmentId);
      socket.join(deptRoom);
      logger.info('agent_joined_department_room', { departmentId, deptRoom });
    });

    // Salir de la sala de departamento (al cambiar de departamento en el selector)
    socket.on('leave_department', (data) => {
      const departmentId = asString(data?.departmentId, { max: 64 });
      if (!departmentId) return;
      const deptRoom = getDepartmentRoom(departmentId);
      socket.leave(deptRoom);
      logger.info('agent_left_department_room', { departmentId, deptRoom });
    });

    socket.on('agent_send_message', async (data, callback) => {
      const ack = safeAck(callback);
      try {
        if (shouldRateLimitSocketEvent(socket, 'agent_send_message', AGENT_SEND_MESSAGE_MAX_PER_MIN, 60_000)) {
          return ack({
            success: false,
            error: `Límite de mensajes alcanzado (máx ${AGENT_SEND_MESSAGE_MAX_PER_MIN}/min)`
          });
        }

        const conversationId = asObjectId(data?.conversationId);
        if (!conversationId) {
          return ack({ success: false, error: 'conversationId es requerido' });
        }

        const payload = validateMessagePayload(data);
        if (payload.error) {
          return ack({ success: false, error: payload.error });
        }

        const result = await recordMessage(
          {
            conversationId,
            senderType: 'agent',
            messageType: payload.messageType,
            content: payload.content,
            attachment: payload.attachment,
            senderName: socket.agentName || 'Agente',
            deliveryChannel: DELIVERY_CHANNELS.SOCKET_AGENT
          },
          io
        );

        ack({ success: true, message: result.message });
      } catch (err) {
        logger.error('agent_send_message_failed', { error: err.message });
        ack({ success: false, error: publicMessage(err) });
      }
    });

    // Indicador: agente está escribiendo
    socket.on('agent_typing', (data) => {
      const conversationId = asObjectId(data?.conversationId);
      if (!conversationId) return;
      const isTyping = !!data.isTyping;
      if (isTyping && shouldThrottleSocketEvent(socket, 'agent_typing', 2000)) return;
      clientNamespace.to(conversationId).emit('user_typing', {
        conversationId,
        senderType: 'agent',
        displayName: 'Agente de soporte',
        isTyping
      });
    });

    // Evento: close_conversation - Finalizar la conversación
    socket.on('close_conversation', async (data, callback) => {
      const ack = safeAck(callback);
      try {
        const conversationId = asObjectId(data?.conversationId);
        if (!conversationId) {
          return ack({ success: false, error: 'ID de conversación inválido' });
        }

        const conversation = await Conversation.findByIdAndUpdate(
          conversationId,
          {
            $set: {
              status: 'closed',
              'metadata.closedAt': new Date().toISOString(),
              'metadata.closedBy': socket.agentName || 'Agente'
            }
          },
          { returnDocument: 'after' }
        )
          .populate('platformId', 'name')
          .lean();

        if (!conversation) {
          return ack({ success: false, error: 'Conversación no encontrada' });
        }

        clientNamespace.to(conversationId).emit('conversation_closed', { conversationId });
        agentNamespace.to(conversationId).emit('conversation_closed', { conversationId });
        // Notificar cambio de lista general (los agentes remueven o archivan el chat)
        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', conversation);

        ack({ success: true, conversation });
      } catch (err) {
        logger.error('close_conversation_failed', { error: err.message });
        ack({ success: false, error: publicMessage(err) });
      }
    });

    socket.on('disconnect', () => {
      logger.info('agent_disconnected');
    });
  });

  return agentNamespace;
}

module.exports = { registerAgentNamespace };
