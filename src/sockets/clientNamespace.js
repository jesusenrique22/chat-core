/**
 * Namespace /client — ciudadanos (Servicios Maracaibo).
 */

const Conversation = require('../models/Conversation');
const { resolveConversationForClient, reopenConversationIfAllowed } = require('../lib/integrations');
const {
  DELIVERY_CHANNELS,
  JOIN_CHAT_MESSAGE_LIMIT,
  recordMessage,
  markMessagesReadByCustomer,
  mapMessagesToData,
  fetchRecentMessagesForConversation,
  fetchOlderMessagesForConversation
} = require('../lib/messageStore');
const { validateMessagePayload } = require('../lib/messageHelpers');
const { isOriginAllowedForPlatform } = require('../lib/cors');
const { findPlatformByApiKey, verifyClientToken } = require('../lib/auth');
const { registerClientCallHandlers } = require('../lib/calls');
const { AGENTS_DASHBOARD_ROOM, getCitizenRoom } = require('../lib/socketRooms');
const { shouldThrottleSocketEvent, shouldRateLimitSocketEvent } = require('../lib/throttle');
const { asString, safeAck } = require('../lib/validate');
const { publicMessage } = require('../lib/errors');
const logger = require('../lib/logger');
const { traceSocketAuth } = require('../lib/requestLog');
const { isSessionToken, resolveCitizen } = require('../lib/citizenAuth');

const SEND_MESSAGE_MAX_PER_MIN = Number(process.env.SEND_MESSAGE_MAX_PER_MIN) || 10;

/** Lee un campo del handshake: primero auth, luego query (clientes legados). */
function handshakeField(socket, key) {
  const auth = socket.handshake.auth || {};
  return auth[key] !== undefined ? auth[key] : socket.handshake.query?.[key];
}

async function authenticateClient(socket, next) {
  const apiKey = asString(handshakeField(socket, 'apiKey'), { max: 512 });
  let customerId = asString(handshakeField(socket, 'customerId'), { max: 128 });
  let customerName = asString(handshakeField(socket, 'customerName'), { max: 200 });
  const ticketId = asString(handshakeField(socket, 'ticketId'), { max: 128 });
  const token = handshakeField(socket, 'token');
  const hasSession = isSessionToken(token);
  const origin = socket.handshake.headers.origin;

  if (!apiKey) {
    return next(new Error('Autenticación fallida: API Key requerida'));
  }
  if (!hasSession && (!customerId || !customerName)) {
    return next(new Error('Autenticación fallida: Datos de cliente incompletos'));
  }
  if (!hasSession && !verifyClientToken(customerId, ticketId, token)) {
    return next(new Error('Autenticación fallida: token de cliente inválido'));
  }

  try {
    const platform = await findPlatformByApiKey(apiKey);
    if (!platform) {
      return next(new Error('Autenticación fallida: API Key no autorizada'));
    }

    // Con sesión de SM la identidad la da SM: se ignora el customerId que envíe la app.
    if (hasSession) {
      const citizen = await resolveCitizen(token);
      if (!citizen) {
        return next(new Error('Autenticación fallida: token de cliente inválido'));
      }
      customerId = citizen.cedula;
      customerName = citizen.name || customerName || 'Ciudadano';
    }

    // Validar origen según plataforma + reglas globales (VPN, .env)
    if (origin && !isOriginAllowedForPlatform(origin, platform)) {
      logger.warn('socket_cors_blocked', { origin, platform: platform.name });
      return next(new Error(`Autenticación de origen bloqueada por CORS: ${origin}`));
    }

    socket.platform = platform;
    socket.customerId = customerId;
    socket.customerName = customerName;
    socket.ticketId = ticketId;
    return next();
  } catch (err) {
    logger.error('client_socket_auth_error', { error: err.message });
    return next(new Error('Error interno del servidor en autenticación'));
  }
}

function registerClientNamespace(io) {
  const clientNamespace = io.of('/client');
  const agentNamespace = io.of('/agent');

  clientNamespace.use(traceSocketAuth(authenticateClient));

  clientNamespace.on('connection', (socket) => {
    logger.info('client_connected', {
      customerId: socket.customerId,
      platform: socket.platform.name
    });
    registerClientCallHandlers(socket, io);
    socket.join(getCitizenRoom(socket.customerId));

    socket.on('join_chat', async (dataOrCallback, maybeCallback) => {
      const callback = safeAck(typeof dataOrCallback === 'function' ? dataOrCallback : maybeCallback);
      try {
        const conversation = await resolveConversationForClient(socket, socket.ticketId);
        const roomId = conversation._id.toString();

        // Un socket = una conversación: salir de la anterior si hace join a otra
        if (socket.conversationId && socket.conversationId !== roomId) {
          socket.leave(socket.conversationId);
        }
        socket.join(roomId);
        socket.conversationId = roomId;

        const messages = await fetchRecentMessagesForConversation(conversation._id);
        const mapped = mapMessagesToData(messages);

        callback({
          success: true,
          conversationId: conversation._id,
          externalTicketId: conversation.externalTicketId || null,
          conversationStatus: conversation.status,
          messages: mapped,
          hasMore: mapped.length >= JOIN_CHAT_MESSAGE_LIMIT
        });

        // Presencia + lecturas en paralelo (después del callback = join más rápido)
        const [populatedConv] = await Promise.all([
          Conversation.findByIdAndUpdate(conversation._id, { isOnline: true }, { returnDocument: 'after' })
            .populate('platformId', 'name')
            .lean(),
          markMessagesReadByCustomer(conversation._id, io) // no-op si no hay unread
        ]);

        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', populatedConv);
        agentNamespace.to([AGENTS_DASHBOARD_ROOM, roomId]).emit('client_presence', {
          conversationId: roomId,
          online: true,
          customerName: socket.customerName
        });
      } catch (err) {
        logger.error('join_chat_failed', { error: err.message });
        callback({ success: false, error: publicMessage(err) });
      }
    });

    socket.on('load_older_messages', async (data, callback) => {
      if (typeof data === 'function') {
        callback = data;
        data = {};
      }
      const ack = safeAck(callback);
      try {
        const conversationId = socket.conversationId;
        if (!conversationId) {
          return ack({ success: false, error: 'No hay conversación activa' });
        }
        const before = data?.before;
        if (!before) {
          return ack({ success: false, error: 'before (timestamp) es requerido' });
        }

        const { messages, hasMore } = await fetchOlderMessagesForConversation(
          conversationId,
          before,
          data?.limit || JOIN_CHAT_MESSAGE_LIMIT
        );

        ack({
          success: true,
          messages: mapMessagesToData(messages),
          hasMore
        });
      } catch (err) {
        logger.error('load_older_messages_failed', { error: err.message });
        ack({ success: false, error: publicMessage(err) });
      }
    });

    socket.on('send_message', async (data, callback) => {
      const ack = safeAck(callback);
      try {
        if (shouldRateLimitSocketEvent(socket, 'send_message', SEND_MESSAGE_MAX_PER_MIN, 60_000)) {
          return ack({
            success: false,
            error: `Límite de mensajes alcanzado (máx ${SEND_MESSAGE_MAX_PER_MIN}/min)`
          });
        }

        const payload = validateMessagePayload(data);
        if (payload.error) {
          return ack({ success: false, error: payload.error });
        }

        const conversationId = socket.conversationId;
        if (!conversationId) {
          return ack({ success: false, error: 'No se ha unido a un chat activo. Ejecute join_chat primero.' });
        }

        // El socket sigue en la sala aunque el chat se cierre mientras lo tiene abierto.
        const conversation = await Conversation.findById(conversationId);
        if (!conversation || !(await reopenConversationIfAllowed(conversation))) {
          return ack({ success: false, code: 'CONVERSATION_CLOSED', error: 'Este caso está cerrado y ya no admite mensajes.' });
        }

        const result = await recordMessage(
          {
            conversationId,
            senderType: 'customer',
            messageType: payload.messageType,
            content: payload.content,
            attachment: payload.attachment,
            deliveryChannel: DELIVERY_CHANNELS.SOCKET_CLIENT
          },
          io
        );

        ack({ success: true, message: result.message });
      } catch (err) {
        logger.error('client_send_message_failed', { error: err.message });
        ack({ success: false, error: publicMessage(err) });
      }
    });

    // El ciudadano vio los mensajes del agente (chat abierto o mensaje nuevo en pantalla)
    socket.on('mark_messages_read', async (data, callback) => {
      if (typeof data === 'function') {
        callback = data;
        data = {};
      }
      const ack = safeAck(callback);
      try {
        const conversationId = socket.conversationId;
        if (!conversationId) {
          return ack({ success: false, error: 'No hay conversación activa' });
        }
        const messageId = asString(data?.messageId, { max: 64 }) || undefined;
        const result = await markMessagesReadByCustomer(conversationId, io, { messageId });
        ack({ success: true, marked: !!result, ...(result || {}) });
      } catch (err) {
        logger.error('mark_messages_read_failed', { error: err.message });
        ack({ success: false, error: publicMessage(err) });
      }
    });

    // Indicador: cliente está escribiendo
    socket.on('client_typing', (data) => {
      const conversationId = socket.conversationId;
      if (!conversationId) return;
      const isTyping = !!(data && data.isTyping);
      if (isTyping && shouldThrottleSocketEvent(socket, 'client_typing', 2000)) return;

      const payload = {
        conversationId,
        senderType: 'customer',
        displayName: socket.customerName,
        isTyping
      };
      agentNamespace.to(conversationId).emit('user_typing', payload);
      agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_typing', payload);
    });

    socket.on('disconnect', async (reason) => {
      logger.info('client_disconnected', { customerId: socket.customerId, reason });

      const conversationId = socket.conversationId;
      if (!conversationId) return;

      const typingPayload = {
        conversationId,
        senderType: 'customer',
        displayName: socket.customerName,
        isTyping: false
      };
      agentNamespace.to(conversationId).emit('user_typing', typingPayload);
      agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_typing', typingPayload);

      try {
        // Otra pestaña/dispositivo del ciudadano sigue conectado → sigue online
        const remaining = await clientNamespace.in(conversationId).fetchSockets();
        if (remaining.length > 0) return;

        agentNamespace.to([AGENTS_DASHBOARD_ROOM, conversationId]).emit('client_presence', {
          conversationId,
          online: false,
          customerName: socket.customerName
        });
        await Conversation.updateOne({ _id: conversationId }, { isOnline: false });
      } catch (err) {
        logger.error('presence_offline_update_failed', { error: err.message });
      }
    });
  });

  return clientNamespace;
}

module.exports = { registerClientNamespace };
