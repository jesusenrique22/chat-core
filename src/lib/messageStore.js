/**
 * Capa única de persistencia y entrega de mensajes.
 * Todo mensaje entrante/saliente pasa por aquí → MongoDB + tiempo real.
 */

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { AGENTS_DASHBOARD_ROOM } = require('./socketRooms');
const {
  getLastMessagePreview,
  toMessageData,
  mapMessagesToData
} = require('./messageHelpers');
const { NOTIFICATIONS_API_URL, NOTIFICATIONS_API_KEY } = require('./env');
const logger = require('./logger');

const DELIVERY_CHANNELS = {
  SOCKET_CLIENT: 'socket_client',
  SOCKET_AGENT: 'socket_agent',
  REST_TICKETS: 'rest_tickets',
  REST_MARACAIBO: 'rest_maracaibo'
};

const JOIN_CHAT_MESSAGE_LIMIT = Number(process.env.JOIN_CHAT_MESSAGE_LIMIT) || 50;
const DEFAULT_HISTORY_LIMIT = 500;
const MAX_HISTORY_LIMIT = 2000;

async function loadConversation(conversationId) {
  const conversation = await Conversation.findById(conversationId).populate('platformId');
  if (!conversation) {
    const err = new Error('Conversación no encontrada');
    err.status = 404;
    throw err;
  }
  return conversation;
}

/** Maracaibo sin query extra si platform está poblado o sourceChannel lo indica. */
function isMaracaiboConversation(conversation) {
  const platform = conversation.platformId;
  if (platform && typeof platform === 'object' && platform.name) {
    return String(platform.name).toLowerCase().includes('maracaibo');
  }
  const channel = conversation.sourceChannel || '';
  return channel.startsWith('maracaibo');
}

function scheduleAsync(task, label) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => logger.error('async_task_failed', { label, error: err.message }));
  });
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
  const preview = getLastMessagePreview(messageType, content);

  const [newMessage] = await Promise.all([
    Message.create({
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
    }),
    Conversation.findByIdAndUpdate(convId, {
      lastMessage: preview,
      updatedAt: new Date()
    })
  ]);

  const messageData = toMessageData(newMessage, convId);
  const roomId = convId.toString();

  if (io) {
    const clientNamespace = io.of('/client');
    const agentNamespace = io.of('/agent');

    if (senderType === 'customer') {
      agentNamespace.to(roomId).emit('new_message', messageData);
      agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_message_received', {
        conversationId: roomId,
        lastMessage: preview
      });
    } else {
      clientNamespace.to(roomId).emit('new_message', messageData);
      agentNamespace.to(roomId).emit('new_message', messageData);
      agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_message_received', {
        conversationId: roomId,
        lastMessage: preview
      });
    }
  }

  if (
    conversation.externalTicketId &&
    senderType === 'customer' &&
    isMaracaiboConversation(conversation)
  ) {
    const ticketId = conversation.externalTicketId;
    let customMessage = `Hey, tienes un mensaje en el ticket ${ticketId}`;
    if (messageType === 'text' && content) {
      customMessage = `Hey, tienes un mensaje en el ticket ${ticketId}: "${content}"`;
    } else if (messageType === 'image') {
      customMessage = `Hey, tienes una imagen nueva en el ticket ${ticketId}`;
    }

    scheduleAsync(
      () => sendExternalNotification(ticketId, 'mensaje', null, customMessage),
      `notificar ticket ${ticketId}`
    );
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
  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || DEFAULT_HISTORY_LIMIT, 1),
    MAX_HISTORY_LIMIT
  );
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

/** Últimos N mensajes en orden cronológico (para join_chat). */
async function fetchRecentMessagesForConversation(conversationId, limit = JOIN_CHAT_MESSAGE_LIMIT) {
  const capped = Math.min(Math.max(parseInt(limit, 10) || JOIN_CHAT_MESSAGE_LIMIT, 1), MAX_HISTORY_LIMIT);
  const messages = await Message.find({ conversationId })
    .sort({ timestamp: -1 })
    .limit(capped);
  messages.reverse();
  return messages;
}

/** Mensajes anteriores a un timestamp (cursor hacia atrás). */
async function fetchOlderMessagesForConversation(
  conversationId,
  before,
  limit = JOIN_CHAT_MESSAGE_LIMIT
) {
  if (!before) {
    return { messages: [], hasMore: false };
  }
  const capped = Math.min(Math.max(parseInt(limit, 10) || JOIN_CHAT_MESSAGE_LIMIT, 1), MAX_HISTORY_LIMIT);
  const messages = await Message.find({
    conversationId,
    timestamp: { $lt: new Date(before) }
  })
    .sort({ timestamp: -1 })
    .limit(capped);
  messages.reverse();
  return { messages, hasMore: messages.length === capped };
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

/**
 * Marca como leídos los mensajes del agente que el ciudadano ya vio.
 * Emite `messages_read` (Socket.IO) y webhook `mensajes_leidos` al Sistema de Tickets.
 *
 * @param {string} conversationId
 * @param {import('socket.io').Server} io
 * @param {{ messageId?: string }} [options] — sin messageId = todos los no leídos
 */
async function markMessagesReadByCustomer(conversationId, io, options = {}) {
  const { messageId } = options;
  const convId = String(conversationId);

  const filter = {
    conversationId: convId,
    senderType: 'agent',
    readByCustomerAt: null
  };
  if (messageId) {
    filter._id = messageId;
  }

  // Early exit barato: sin unread → sin update ni webhook
  const hasUnread = await Message.exists(filter);
  if (!hasUnread) return null;

  const conversation = await Conversation.findById(conversationId).select('externalTicketId');
  if (!conversation) return null;

  const readAt = new Date();
  const readAtIso = readAt.toISOString();

  await Message.updateMany(filter, { $set: { readByCustomerAt: readAt } });

  const ticketId = String(conversation.externalTicketId || '').trim();
  const isSingle = !!messageId;

  const payload = {
    type: isSingle ? 'message_read' : 'messages_read',
    ticketId,
    externalTicketId: ticketId,
    conversationId: convId,
    readAt: readAtIso
  };
  if (isSingle) {
    payload.messageId = String(messageId);
  }

  if (io) {
    io.of('/agent').to(convId).emit('messages_read', payload);
  }

  if (ticketId) {
    scheduleAsync(
      () =>
        sendReadReceiptNotification({
          ticketId,
          conversationId: convId,
          readAt: readAtIso,
          messageId: isSingle ? String(messageId) : undefined
        }),
      `lectura ticket ${ticketId}`
    );
  }

  return payload;
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
 * Webhook de recibos de lectura → Sistema de Tickets (persistencia).
 * Tipos: mensajes_leidos (todos) | mensaje_leido (uno).
 */
async function sendReadReceiptNotification({ ticketId, conversationId, readAt, messageId }) {
  const type = messageId ? 'mensaje_leido' : 'mensajes_leidos';

  const payload = {
    type,
    ticketId,
    conversationId,
    readAt
  };
  if (messageId) {
    payload.messageId = messageId;
  }

  logger.info('read_receipt_webhook', { ticketId, type });

  try {
    const response = await fetch(NOTIFICATIONS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': NOTIFICATIONS_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.warn('read_receipt_webhook_failed', {
        ticketId,
        status: response.status,
        body: errorText.slice(0, 200)
      });
    } else {
      logger.info('read_receipt_webhook_ok', { ticketId, type });
    }
  } catch (error) {
    logger.error('read_receipt_webhook_error', { ticketId, error: error.message });
  }
}

/**
 * Envía una notificación HTTP POST a la API externa de notificaciones.
 * No arroja excepciones para evitar romper el flujo principal del chat si el servidor de notificaciones falla.
 */
async function sendExternalNotification(ticketId, type = 'mensaje', status = null, customMessage = null) {
  const messageText = customMessage || `Hey, tienes un mensaje en el ticket ${ticketId}`;
  logger.info('ticket_notification', { ticketId, type });

  try {
    const payload = {
      ticketId,
      type,
      message: messageText
    };
    if (status) {
      payload.status = status;
    }

    const response = await fetch(NOTIFICATIONS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': NOTIFICATIONS_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.warn('ticket_notification_failed', {
        ticketId,
        status: response.status,
        body: errorText.slice(0, 200)
      });
    } else {
      logger.info('ticket_notification_ok', { ticketId, type });
    }
  } catch (error) {
    logger.error('ticket_notification_error', { ticketId, error: error.message });
  }
}

module.exports = {
  DELIVERY_CHANNELS,
  JOIN_CHAT_MESSAGE_LIMIT,
  recordMessage,
  markMessagesReadByCustomer,
  loadConversation,
  findConversationByTicketId,
  fetchMessagesForConversation,
  fetchRecentMessagesForConversation,
  fetchOlderMessagesForConversation,
  buildStructuredHistory,
  getConversationHistory,
  getTicketHistory,
  mapMessagesToData,
  sendExternalNotification,
  sendReadReceiptNotification
};
