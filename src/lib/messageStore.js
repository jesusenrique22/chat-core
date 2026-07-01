/**
 * Capa única de persistencia y entrega de mensajes.
 * Todo mensaje entrante/saliente pasa por aquí → MongoDB + tiempo real.
 */

const Platform = require('../models/Platform');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const {
  getLastMessagePreview,
  toMessageData,
  mapMessagesToData
} = require('./messageHelpers');

const DELIVERY_CHANNELS = {
  SOCKET_CLIENT: 'socket_client',
  SOCKET_AGENT: 'socket_agent',
  REST_TICKETS: 'rest_tickets',
  REST_MARACAIBO: 'rest_maracaibo'
};

async function loadConversation(conversationId) {
  const conversation = await Conversation.findById(conversationId).populate('platformId');
  if (!conversation) {
    const err = new Error('Conversación no encontrada');
    err.status = 404;
    throw err;
  }
  return conversation;
}

/**
 * Guarda mensaje en BDD y lo entrega por Socket.io.
 */
async function recordMessage(
  {
    conversationId,
    conversation: conversationDoc,
    senderType,
    messageType,
    content,
    attachment,
    senderName = '',
    deliveryChannel
  },
  io
) {
  const conversation = conversationDoc || (await loadConversation(conversationId));
  const convId = conversation._id;

  const newMessage = await Message.create({
    conversationId: convId,
    senderType,
    messageType: messageType || 'text',
    content: content || '',
    attachment: attachment || null,
    senderName: senderName || '',
    deliveryChannel: deliveryChannel || DELIVERY_CHANNELS.SOCKET_CLIENT,
    externalTicketId: conversation.externalTicketId || '',
    customerId: conversation.customerId,
    direction: senderType === 'customer' ? 'inbound' : 'outbound'
  });

  const preview = getLastMessagePreview(messageType, content);
  await Conversation.findByIdAndUpdate(convId, {
    lastMessage: preview,
    updatedAt: new Date()
  });

  const messageData = toMessageData(newMessage, convId);
  const roomId = convId.toString();

  if (io) {
    const clientNamespace = io.of('/client');
    const agentNamespace = io.of('/agent');

    if (senderType === 'customer') {
      agentNamespace.to(roomId).emit('new_message', messageData);
      agentNamespace.emit('conversation_message_received', {
        conversationId: roomId,
        lastMessage: preview
      });
    } else {
      clientNamespace.to(roomId).emit('new_message', messageData);
      agentNamespace.to(roomId).emit('new_message', messageData);
      agentNamespace.emit('conversation_message_received', {
        conversationId: roomId,
        lastMessage: preview
      });
    }
  }

  // Disparar notificación externa al sistema de tickets solo si el mensaje proviene del ciudadano (customer)
  if (conversation.externalTicketId && senderType === 'customer') {
    let isMaracaibo = false;
    try {
      let platform = conversation.platformId;
      if (platform && typeof platform === 'object' && platform.name) {
        isMaracaibo = platform.name.toLowerCase().includes('maracaibo');
      } else if (platform) {
        // Si no está poblado, cargarlo de la base de datos
        const platformDoc = await Platform.findById(platform);
        if (platformDoc) {
          isMaracaibo = platformDoc.name.toLowerCase().includes('maracaibo');
        }
      }
    } catch (platformErr) {
      console.error('[Notificación] Error al verificar plataforma:', platformErr.message);
    }

    if (isMaracaibo) {
      let customMessage = `Hey, tienes un mensaje en el ticket ${conversation.externalTicketId}`;
      if (messageType === 'text' && content) {
        customMessage = `Hey, tienes un mensaje en el ticket ${conversation.externalTicketId}: "${content}"`;
      } else if (messageType === 'image') {
        customMessage = `Hey, tienes una imagen nueva en el ticket ${conversation.externalTicketId}`;
      }

      sendExternalNotification(conversation.externalTicketId, 'mensaje', null, customMessage)
        .catch((err) => console.error(`[Notificación] Error asíncrono al notificar ticket ${conversation.externalTicketId}:`, err.message));
    }
  }

  return { message: messageData, conversation };
}

async function findConversationByTicketId(ticketId, { activeOnly = false } = {}) {
  const id = String(ticketId).trim();
  if (!id) return null;

  if (activeOnly) {
    return Conversation.findOne({ externalTicketId: id, status: 'active' });
  }

  const active = await Conversation.findOne({ externalTicketId: id, status: 'active' });
  if (active) return active;

  return Conversation.findOne({ externalTicketId: id }).sort({ updatedAt: -1 });
}

function parseHistoryQuery(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 2000);
  const skip = Math.max(parseInt(query.skip, 10) || 0, 0);
  const filter = {};

  if (query.after) {
    filter.timestamp = { ...filter.timestamp, $gte: new Date(query.after) };
  }
  if (query.before) {
    filter.timestamp = { ...filter.timestamp, $lte: new Date(query.before) };
  }
  if (query.senderType === 'customer' || query.senderType === 'agent') {
    filter.senderType = query.senderType;
  }
  if (query.messageType === 'text' || query.messageType === 'image') {
    filter.messageType = query.messageType;
  }

  return { limit, skip, filter };
}

async function fetchMessagesForConversation(conversationId, query = {}) {
  const { limit, skip, filter } = parseHistoryQuery(query);
  const baseFilter = { conversationId, ...filter };

  const [messages, total] = await Promise.all([
    Message.find(baseFilter).sort({ timestamp: 1 }).skip(skip).limit(limit),
    Message.countDocuments(baseFilter)
  ]);

  return { messages, total, limit, skip };
}

function computeMessageStats(messages) {
  const formatted = mapMessagesToData(messages);
  return {
    total: formatted.length,
    fromCustomer: formatted.filter((m) => m.senderType === 'customer').length,
    fromAgent: formatted.filter((m) => m.senderType === 'agent').length,
    textCount: formatted.filter((m) => m.messageType === 'text').length,
    imageCount: formatted.filter((m) => m.messageType === 'image').length,
    inbound: formatted.filter((m) => m.direction === 'inbound').length,
    outbound: formatted.filter((m) => m.direction === 'outbound').length
  };
}

function buildStructuredHistory(conversation, messages, meta = {}) {
  const formatted = mapMessagesToData(messages);
  return {
    success: true,
    conversation: {
      id: conversation._id,
      externalTicketId: conversation.externalTicketId || null,
      customerId: conversation.customerId,
      customerName: conversation.customerName,
      status: conversation.status,
      sourceChannel: conversation.sourceChannel,
      metadata: conversation.metadata || {},
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    },
    stats: computeMessageStats(messages),
    pagination: {
      total: meta.total ?? formatted.length,
      limit: meta.limit ?? formatted.length,
      skip: meta.skip ?? 0,
      returned: formatted.length
    },
    messages: formatted
  };
}

async function getConversationHistory(conversationId, query = {}) {
  const conversation = await loadConversation(conversationId);
  const { messages, total, limit, skip } = await fetchMessagesForConversation(conversationId, query);
  return buildStructuredHistory(conversation, messages, { total, limit, skip });
}

async function getTicketHistory(ticketId, query = {}) {
  const conversation = await findConversationByTicketId(ticketId, { activeOnly: false });
  if (!conversation) {
    const err = new Error(`No hay conversación para el ticket "${ticketId}"`);
    err.status = 404;
    throw err;
  }

  const { messages, total, limit, skip } = await fetchMessagesForConversation(conversation._id, query);
  return buildStructuredHistory(conversation, messages, { total, limit, skip });
}

/**
 * Envía una notificación HTTP POST a la API externa de notificaciones.
 * No arroja excepciones para evitar romper el flujo principal del chat si el servidor de notificaciones falla.
 */
async function sendExternalNotification(ticketId, type = 'mensaje', status = null, customMessage = null) {
  const url = process.env.NOTIFICATIONS_API_URL || 'https://ticketsotravez.onrender.com/notifications/ticket';
  const apiKey = process.env.NOTIFICATIONS_API_KEY || 'tickets_secret_key_2026';
  
  const messageText = customMessage || `Hey, tienes un mensaje en el ticket ${ticketId}`;
  console.log(`[Notificación] Enviando POST a ${url} para Ticket: ${ticketId}, Tipo: ${type}, Mensaje: "${messageText}"`);

  try {
    // Payload exacto que espera el Sistema de Tickets
    const payload = { 
      ticketId, 
      type,
      message: messageText
    };
    if (status) {
      payload.status = status;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.warn(`[Notificación] Servidor externo respondió con código ${response.status}: ${errorText}`);
    } else {
      const data = await response.json().catch(() => ({}));
      console.log(`[Notificación] Notificación enviada con éxito para Ticket ${ticketId}:`, data.success ? 'ok' : JSON.stringify(data));
    }
  } catch (error) {
    console.error(`[Notificación] Error de conexión al notificar Ticket ${ticketId}:`, error.message);
  }
}

module.exports = {
  DELIVERY_CHANNELS,
  recordMessage,
  loadConversation,
  findConversationByTicketId,
  fetchMessagesForConversation,
  buildStructuredHistory,
  getConversationHistory,
  getTicketHistory,
  mapMessagesToData,
  sendExternalNotification
};
