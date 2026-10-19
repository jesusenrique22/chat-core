/**
 * Capa única de persistencia y entrega de mensajes.
 * Todo mensaje entrante/saliente pasa por aquí → MongoDB + tiempo real.
 */

const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { AGENTS_DASHBOARD_ROOM } = require('./socketRooms');
const {
  getLastMessagePreview,
  toMessageData,
  mapMessagesToData
} = require('./messageHelpers');
const { enqueueWebhook } = require('./webhooks');
const { asObjectId, asDate, clampInt } = require('./validate');
const { notFound, badRequest } = require('./errors');
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
/** Máximo por página en sockets (join/load_older): evita respuestas gigantes por WS. */
const MAX_SOCKET_PAGE = 200;

function requireConversationId(conversationId) {
  const id = asObjectId(conversationId);
  if (!id) throw badRequest('conversationId inválido');
  return id;
}

async function loadConversation(conversationId, { lean = true } = {}) {
  const id = requireConversationId(conversationId);
  const query = Conversation.findById(id).populate('platformId', 'name');
  const conversation = lean ? await query.lean() : await query;
  if (!conversation) throw notFound('Conversación no encontrada');
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

  const now = new Date();
  const [newMessage, updatedConversation] = await Promise.all([
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
    Conversation.findByIdAndUpdate(
      convId,
      {
        lastMessage: preview,
        updatedAt: now,
        ...(senderType === 'customer' ? { lastCustomerMessageAt: now } : {})
      },
      { returnDocument: 'after' }
    )
      .populate('platformId', 'name')
      .lean()
  ]);

  const messageData = toMessageData(newMessage, convId);
  const roomId = convId.toString();

  if (io) {
    const clientNamespace = io.of('/client');
    const agentNamespace = io.of('/agent');

    if (senderType === 'customer') {
      // Sala de la conversación + dashboard en una sola emisión: Socket.io deduplica,
      // así un agente que está en ambas salas recibe el mensaje UNA vez.
      agentNamespace.to([roomId, AGENTS_DASHBOARD_ROOM]).emit('new_message', messageData);
      agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_message_received', {
        conversationId: roomId,
        lastMessage: preview,
        externalTicketId: conversation.externalTicketId || null,
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

  // Webhook al panel de tickets: cualquier ciudadano con ticket enlazado.
  if (conversation.externalTicketId && senderType === 'customer') {
    const ticketId = conversation.externalTicketId;
    let customMessage = `Hey, tienes un mensaje en el ticket ${ticketId}`;
    if (messageType === 'text' && content) {
      customMessage = `Hey, tienes un mensaje en el ticket ${ticketId}: "${content}"`;
    } else if (messageType === 'image') {
      customMessage = `Hey, tienes una imagen nueva en el ticket ${ticketId}`;
    }

    logger.info('ticket_notify_queued', {
      ticketId,
      maracaibo: isMaracaiboConversation(updatedConversation || conversation),
    });
    sendExternalNotification(ticketId, 'mensaje', null, customMessage);
  } else if (senderType === 'customer') {
    logger.warn('customer_message_without_ticket', { conversationId: String(convId) });
  }

  return { message: messageData, conversation: updatedConversation || conversation };
}

async function findConversationByTicketId(ticketId, { activeOnly = false } = {}) {
  if (typeof ticketId !== 'string' && typeof ticketId !== 'number') return null;
  const id = String(ticketId).trim();
  if (!id) return null;

  if (activeOnly) {
    return Conversation.findOne({ externalTicketId: id, status: 'active' });
  }

  const active = await Conversation.findOne({ externalTicketId: id, status: 'active' });
  if (active) return active;

  return Conversation.findOne({ externalTicketId: id }).sort({ updatedAt: -1 });
}

function parseHistoryQuery(query = {}) {
  const limit = clampInt(query.limit, { min: 1, max: MAX_HISTORY_LIMIT, fallback: DEFAULT_HISTORY_LIMIT });
  const skip = clampInt(query.skip, { min: 0, max: 1_000_000, fallback: 0 });
  const filter = {};

  const after = asDate(query.after);
  const before = asDate(query.before);
  if (after) filter.timestamp = { ...filter.timestamp, $gte: after };
  if (before) filter.timestamp = { ...filter.timestamp, $lte: before };
  if (query.senderType === 'customer' || query.senderType === 'agent') {
    filter.senderType = query.senderType;
  }
  if (query.messageType === 'text' || query.messageType === 'image') {
    filter.messageType = query.messageType;
  }

  return { limit, skip, filter };
}

/** Estadísticas sobre TODO el filtro (no solo la página) en una sola agregación. */
async function aggregateMessageStats(baseFilter) {
  const inboundExpr = {
    $eq: [
      { $ifNull: ['$direction', { $cond: [{ $eq: ['$senderType', 'customer'] }, 'inbound', 'outbound'] }] },
      'inbound'
    ]
  };
  const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

  const [row] = await Message.aggregate([
    { $match: baseFilter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        fromCustomer: countIf({ $eq: ['$senderType', 'customer'] }),
        fromAgent: countIf({ $eq: ['$senderType', 'agent'] }),
        imageCount: countIf({ $eq: ['$messageType', 'image'] }),
        inbound: countIf(inboundExpr)
      }
    }
  ]);

  if (!row) {
    return { total: 0, fromCustomer: 0, fromAgent: 0, textCount: 0, imageCount: 0, inbound: 0, outbound: 0 };
  }
  return {
    total: row.total,
    fromCustomer: row.fromCustomer,
    fromAgent: row.fromAgent,
    textCount: row.total - row.imageCount,
    imageCount: row.imageCount,
    inbound: row.inbound,
    outbound: row.total - row.inbound
  };
}

async function fetchMessagesForConversation(conversationId, query = {}) {
  const id = requireConversationId(conversationId);
  const { limit, skip, filter } = parseHistoryQuery(query);
  const baseFilter = { conversationId: new mongoose.Types.ObjectId(id), ...filter };

  const [messages, stats] = await Promise.all([
    Message.find(baseFilter).sort({ timestamp: 1 }).skip(skip).limit(limit).lean(),
    aggregateMessageStats(baseFilter)
  ]);

  return { messages, total: stats.total, stats, limit, skip };
}

/** Últimos N mensajes en orden cronológico (para join_chat). */
async function fetchRecentMessagesForConversation(conversationId, limit = JOIN_CHAT_MESSAGE_LIMIT) {
  const capped = clampInt(limit, { min: 1, max: MAX_SOCKET_PAGE, fallback: JOIN_CHAT_MESSAGE_LIMIT });
  const messages = await Message.find({ conversationId })
    .sort({ timestamp: -1 })
    .limit(capped)
    .lean();
  messages.reverse();
  return messages;
}

/** Mensajes anteriores a un timestamp (cursor hacia atrás). */
async function fetchOlderMessagesForConversation(
  conversationId,
  before,
  limit = JOIN_CHAT_MESSAGE_LIMIT
) {
  const beforeDate = asDate(before);
  if (!beforeDate) {
    return { messages: [], hasMore: false };
  }
  const capped = clampInt(limit, { min: 1, max: MAX_SOCKET_PAGE, fallback: JOIN_CHAT_MESSAGE_LIMIT });
  const messages = await Message.find({
    conversationId,
    timestamp: { $lt: beforeDate }
  })
    .sort({ timestamp: -1 })
    .limit(capped)
    .lean();
  messages.reverse();
  return { messages, hasMore: messages.length === capped };
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
    stats: meta.stats,
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
  const [conversation, page] = await Promise.all([
    loadConversation(conversationId),
    fetchMessagesForConversation(conversationId, query)
  ]);
  return buildStructuredHistory(conversation, page.messages, page);
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
  const convId = asObjectId(String(conversationId));
  if (!convId) return null;

  let messageId;
  if (options.messageId !== undefined && options.messageId !== null && options.messageId !== '') {
    messageId = asObjectId(options.messageId);
    if (!messageId) return null;
  }

  const filter = {
    conversationId: convId,
    senderType: 'agent',
    readByCustomerAt: null
  };
  if (messageId) {
    filter._id = messageId;
  }

  const readAt = new Date();
  const readAtIso = readAt.toISOString();

  // Un solo round-trip: si no había no leídos, modifiedCount = 0 → sin evento ni webhook
  const { modifiedCount } = await Message.updateMany(filter, { $set: { readByCustomerAt: readAt } });
  if (!modifiedCount) return null;

  const conversation = await Conversation.findById(convId).select('externalTicketId').lean();
  if (!conversation) return null;

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
    sendReadReceiptNotification({
      ticketId,
      conversationId: convId,
      readAt: readAtIso,
      messageId: isSingle ? String(messageId) : undefined
    });
  }

  return payload;
}

async function getTicketHistory(ticketId, query = {}) {
  const conversation = await findConversationByTicketId(ticketId, { activeOnly: false });
  if (!conversation) {
    throw notFound(`No hay conversación para el ticket "${ticketId}"`);
  }

  const page = await fetchMessagesForConversation(String(conversation._id), query);
  return buildStructuredHistory(conversation, page.messages, page);
}

/**
 * Webhook de recibos de lectura → Sistema de Tickets (persistencia).
 * Tipos: mensajes_leidos (todos) | mensaje_leido (uno).
 * Se encola: timeout + reintentos, no bloquea el flujo del chat.
 */
function sendReadReceiptNotification({ ticketId, conversationId, readAt, messageId }) {
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

  logger.info('read_receipt_webhook_queued', { ticketId, type });
  return enqueueWebhook(payload, `lectura ticket ${ticketId}`);
}

/**
 * Notificación al Sistema de Tickets. Se encola (no lanza excepciones): si el servidor de
 * notificaciones falla, se reintenta con backoff sin romper el flujo del chat.
 */
function sendExternalNotification(ticketId, type = 'mensaje', status = null, customMessage = null) {
  const payload = {
    ticketId,
    type,
    message: customMessage || `Hey, tienes un mensaje en el ticket ${ticketId}`
  };
  if (status) {
    payload.status = status;
  }
  logger.info('ticket_notification_queued', { ticketId, type });
  return enqueueWebhook(payload, `notificar ticket ${ticketId}`);
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
