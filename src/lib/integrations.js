/**
 * Lógica del conector: validación de plataformas, enlace ticket ↔ chat, mensajes.
 */

const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const {
  validateMessagePayload
} = require('./messageHelpers');
const {
  DELIVERY_CHANNELS,
  recordMessage,
  findConversationByTicketId,
  getTicketHistory
} = require('./messageStore');
const {
  authenticateRequest,
  getMaracaiboPlatform,
  isMaracaiboPlatform,
  isTicketsPlatform
} = require('./auth');
const { asString, clampInt, normalizeCustomerId } = require('./validate');
const { badRequest, forbidden, notFound } = require('./errors');
const { AGENTS_DASHBOARD_ROOM } = require('./socketRooms');
const { getUptimeSec, getStartedAtIso } = require('./runtime');
const logger = require('./logger');

const MONGO_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting'
};

const MAX_METADATA_BYTES = 8 * 1024;
const OVERDUE_MAX_HOURS = 24 * 90;

async function checkMongoHealth() {
  const readyState = mongoose.connection.readyState;
  const state = MONGO_STATES[readyState] || `unknown(${readyState})`;

  if (readyState !== 1 || !mongoose.connection.db) {
    return { ok: false, state };
  }

  try {
    await mongoose.connection.db.admin().ping();
    return { ok: true, state };
  } catch (err) {
    return { ok: false, state, error: err.message };
  }
}

/** metadata debe ser un objeto plano, pequeño y sin claves de operador Mongo. */
function sanitizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw badRequest('metadata debe ser un objeto');
  }
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json) > MAX_METADATA_BYTES) {
    throw badRequest('metadata demasiado grande (máx 8 KB)');
  }
  return JSON.parse(json, (key, value) => (key.startsWith('$') || key.includes('.') ? undefined : value));
}

/**
 * Crea una conversación activa para el ticket; si otra petición concurrente la creó primero
 * (índice único parcial en externalTicketId activo), devuelve esa en lugar de duplicarla.
 */
async function createActiveConversationForTicket(data) {
  try {
    return await Conversation.create({ ...data, status: 'active' });
  } catch (err) {
    if (err?.code === 11000 && data.externalTicketId) {
      const existing = await Conversation.findOne({ externalTicketId: data.externalTicketId, status: 'active' });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Busca o crea conversación enlazada a un ticket.
 * La conversación del ciudadano siempre pertenece a la plataforma Maracaibo.
 */
async function linkConversation({
  ticketId,
  customerId,
  customerName,
  sourceChannel = 'maracaibo_app',
  metadata = {}
}) {
  const ticketIdStr = asString(ticketId, { max: 128 });
  const customerIdStr = asString(customerId, { max: 128 });
  const customerNameStr = asString(customerName, { max: 200 });
  if (!ticketIdStr || !customerIdStr || !customerNameStr) {
    throw badRequest('ticketId, customerId y customerName son obligatorios');
  }
  const channel = asString(sourceChannel, { max: 40 }) || 'maracaibo_app';
  const cleanMetadata = sanitizeMetadata(metadata);

  const maracaiboPlatform = await getMaracaiboPlatform();

  let conversation = await Conversation.findOne({
    externalTicketId: ticketIdStr,
    status: 'active'
  });

  if (conversation) {
    conversation.customerId = customerIdStr;
    conversation.customerName = customerNameStr;
    conversation.sourceChannel = channel;
    conversation.metadata = { ...conversation.metadata, ...cleanMetadata };
    await conversation.save();
  } else {
    // Reabrir conversación cerrada de ESTE ticket (no otra del mismo customer)
    const closed = await Conversation.findOne({
      externalTicketId: ticketIdStr,
      status: 'closed'
    }).sort({ updatedAt: -1 });

    if (closed) {
      closed.status = 'active';
      closed.customerId = customerIdStr;
      closed.customerName = customerNameStr;
      closed.sourceChannel = channel;
      closed.metadata = { ...closed.metadata, ...cleanMetadata };
      await closed.save();
      conversation = closed;
    } else {
      // Ticket nuevo → conversación nueva (aunque el customerId ya tenga otros tickets)
      conversation = await createActiveConversationForTicket({
        platformId: maracaiboPlatform._id,
        customerId: customerIdStr,
        customerName: customerNameStr,
        externalTicketId: ticketIdStr,
        sourceChannel: channel,
        metadata: cleanMetadata
      });
    }
  }

  return conversation.populate('platformId', 'name');
}

/**
 * Un ciudadano solo puede tomar la conversación de un ticket que ya es suyo.
 * La cédula se compara normalizada: el panel guarda la del ticket tal cual ("V-12345678")
 * y la app envía "V12345678".
 */
function assertCustomerOwnsConversation(conversation, socket) {
  if (!conversation.customerId) return;
  if (normalizeCustomerId(conversation.customerId) === normalizeCustomerId(socket.customerId)) return;

  logger.warn('client_ticket_owner_mismatch_rejected', {
    ticketId: conversation.externalTicketId,
    conversationId: String(conversation._id)
  });
  throw forbidden('El ticket pertenece a otro ciudadano');
}

/**
 * Resuelve conversación para join_chat (socket cliente).
 */
async function resolveConversationForClient(socket, ticketIdFromAuth) {
  const maracaiboPlatform = isMaracaiboPlatform(socket.platform)
    ? socket.platform
    : await getMaracaiboPlatform();

  const ticketId = asString(ticketIdFromAuth, { max: 128 });

  if (ticketId) {
    const byTicket = await Conversation.findOne({
      externalTicketId: ticketId,
      status: 'active'
    });
    if (byTicket) {
      if (byTicket.customerId !== socket.customerId) {
        assertCustomerOwnsConversation(byTicket, socket);
        byTicket.customerId = socket.customerId;
        byTicket.customerName = socket.customerName;
        await byTicket.save();
      }
      return byTicket;
    }

    const closedByTicket = await Conversation.findOne({
      externalTicketId: ticketId,
      status: 'closed'
    }).sort({ updatedAt: -1 });
    if (closedByTicket) {
      assertCustomerOwnsConversation(closedByTicket, socket);
      closedByTicket.status = 'active';
      closedByTicket.customerId = socket.customerId;
      closedByTicket.customerName = socket.customerName;
      await closedByTicket.save();
      return closedByTicket;
    }

    // Ticket sin conversación previa → crear una nueva (no reutilizar otro ticket del mismo usuario)
    return createActiveConversationForTicket({
      platformId: maracaiboPlatform._id,
      customerId: socket.customerId,
      customerName: socket.customerName,
      externalTicketId: ticketId,
      sourceChannel: isMaracaiboPlatform(socket.platform) ? 'maracaibo_web' : 'maracaibo_app'
    });
  }

  // Sin ticketId (demo/widget legacy): una conversación activa por customerId
  let conversation = await Conversation.findOne({
    platformId: maracaiboPlatform._id,
    customerId: socket.customerId,
    status: 'active',
    externalTicketId: { $in: [null, ''] }
  });

  if (!conversation) {
    conversation = await Conversation.findOne({
      platformId: maracaiboPlatform._id,
      customerId: socket.customerId,
      status: 'active'
    });
  }

  if (!conversation) {
    const closedLegacy = await Conversation.findOne({
      platformId: maracaiboPlatform._id,
      customerId: socket.customerId,
      status: 'closed',
      $or: [{ externalTicketId: { $exists: false } }, { externalTicketId: null }, { externalTicketId: '' }]
    }).sort({ updatedAt: -1 });
    if (closedLegacy) {
      closedLegacy.status = 'active';
      closedLegacy.customerName = socket.customerName;
      await closedLegacy.save();
      return closedLegacy;
    }
  }

  if (!conversation) {
    conversation = await Conversation.create({
      platformId: maracaiboPlatform._id,
      customerId: socket.customerId,
      customerName: socket.customerName,
      sourceChannel: isMaracaiboPlatform(socket.platform) ? 'maracaibo_web' : 'unknown',
      status: 'active'
    });
  }

  return conversation;
}

async function findActiveConversationByTicketId(ticketId) {
  const conversation = await findConversationByTicketId(ticketId, { activeOnly: true });
  if (!conversation) {
    throw notFound(
      `No hay conversación activa para el ticket "${ticketId}". Ejecute POST /api/integrations/conversations/link primero.`
    );
  }
  return conversation;
}

/**
 * Guarda mensaje del agente (sistema de tickets) y lo entrega al cliente Maracaibo.
 */
async function deliverAgentMessage(
  { ticketId, content, agentName, messageType, attachment },
  io
) {
  const conversation = await findActiveConversationByTicketId(ticketId);
  const payload = validateMessagePayload({ messageType, content, attachment });
  if (payload.error) {
    throw badRequest(payload.error);
  }

  const result = await recordMessage(
    {
      conversation,
      senderType: 'agent',
      messageType: payload.messageType,
      content: payload.content,
      attachment: payload.attachment,
      senderName: asString(agentName, { max: 120 }) || 'Agente de soporte',
      deliveryChannel: DELIVERY_CHANNELS.REST_TICKETS
    },
    io
  );

  // recordMessage ya devuelve la conversación actualizada y poblada → sin re-consulta
  io.of('/agent').to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', result.conversation);

  return { message: result.message, conversation: result.conversation };
}

/**
 * Guarda mensaje del ciudadano vía REST (opcional, además del socket).
 */
async function deliverCustomerMessage(
  { ticketId, customerId, content, messageType, attachment },
  io
) {
  const conversation = await findActiveConversationByTicketId(ticketId);

  if (normalizeCustomerId(conversation.customerId) !== normalizeCustomerId(customerId)) {
    throw forbidden('customerId no coincide con el ticket enlazado');
  }

  const payload = validateMessagePayload({ messageType, content, attachment });
  if (payload.error) {
    throw badRequest(payload.error);
  }

  return recordMessage(
    {
      conversation,
      senderType: 'customer',
      messageType: payload.messageType,
      content: payload.content,
      attachment: payload.attachment,
      deliveryChannel: DELIVERY_CHANNELS.REST_MARACAIBO
    },
    io
  );
}

/**
 * Cierra la conversación activa de un ticket (agente / sistema de tickets).
 * Los mensajes permanecen en BDD; al reabrir el ticket se reactiva la misma conversación.
 */
async function closeConversationByTicketId({ ticketId, closedBy, reason }, io) {
  const conversation = await findActiveConversationByTicketId(ticketId);
  const roomId = conversation._id.toString();

  conversation.status = 'closed';
  conversation.metadata = {
    ...conversation.metadata,
    closedAt: new Date().toISOString(),
    closedBy: asString(closedBy, { max: 120 }) || 'Agente de soporte',
    closeReason: asString(reason, { max: 1000 }) || ''
  };
  await conversation.save();

  const populatedConv = await conversation.populate('platformId', 'name');

  if (io) {
    const clientNamespace = io.of('/client');
    const agentNamespace = io.of('/agent');
    clientNamespace.to(roomId).emit('conversation_closed', { conversationId: roomId });
    agentNamespace.to(roomId).emit('conversation_closed', { conversationId: roomId });
    agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', populatedConv);
  }

  return populatedConv;
}

function registerIntegrationRoutes(expressApp, io) {
  expressApp.post('/api/integrations/conversations/link', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isMaracaiboPlatform(platform) && !isTicketsPlatform(platform)) {
      return res.status(403).json({ error: 'Plataforma no autorizada para enlazar conversaciones' });
    }

    const { ticketId, customerId, customerName, sourceChannel, metadata } = req.body || {};
    const conversation = await linkConversation({
      ticketId,
      customerId,
      customerName,
      sourceChannel: sourceChannel || 'maracaibo_app',
      metadata: metadata || {}
    });

    io.of('/agent').to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', conversation);

    res.status(201).json({
      success: true,
      conversationId: conversation._id,
      externalTicketId: conversation.externalTicketId,
      customerId: conversation.customerId,
      customerName: conversation.customerName
    });
  });

  /** Sistema de Tickets → ciudadano (app Maracaibo) */
  expressApp.post('/api/integrations/messages', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isTicketsPlatform(platform)) {
      return res.status(403).json({
        error: 'Solo la plataforma Sistema de Tickets puede enviar mensajes por esta ruta'
      });
    }

    const { ticketId, content, agentName, messageType, attachment } = req.body || {};
    if (!asString(ticketId, { max: 128 })) {
      return res.status(400).json({ error: 'ticketId es obligatorio' });
    }

    const result = await deliverAgentMessage(
      { ticketId, content, agentName, messageType, attachment },
      io
    );

    res.status(201).json({
      success: true,
      ...result
    });
  });

  /** Ciudadano → REST (alternativa al socket); requiere API Key Maracaibo */
  expressApp.post('/api/integrations/messages/inbound', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isMaracaiboPlatform(platform)) {
      return res.status(403).json({
        error: 'Solo Servicios Maracaibo puede enviar mensajes inbound por REST'
      });
    }

    const { ticketId, customerId, content, messageType, attachment } = req.body || {};
    if (!asString(ticketId, { max: 128 }) || !asString(customerId, { max: 128 })) {
      return res.status(400).json({ error: 'ticketId y customerId son obligatorios' });
    }

    const result = await deliverCustomerMessage(
      { ticketId, customerId, content, messageType, attachment },
      io
    );

    res.status(201).json({ success: true, ...result });
  });

  /** Historial estructurado por ticketId (activo o cerrado) */
  expressApp.get('/api/integrations/conversations/:ticketId/messages', async (req, res) => {
    await authenticateRequest(req);
    const history = await getTicketHistory(req.params.ticketId, req.query);
    res.json(history);
  });

  /** Alias explícito de historial / trazabilidad por ticket */
  expressApp.get('/api/integrations/history/ticket/:ticketId', async (req, res) => {
    await authenticateRequest(req);
    const history = await getTicketHistory(req.params.ticketId, req.query);
    res.json(history);
  });

  /** Agente en Sistema de Tickets → cerrar conversación del ticket */
  expressApp.post('/api/integrations/conversations/:ticketId/close', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isTicketsPlatform(platform)) {
      return res.status(403).json({
        error: 'Solo la plataforma Sistema de Tickets puede cerrar conversaciones por esta ruta'
      });
    }

    const { closedBy, reason } = req.body || {};
    const conversation = await closeConversationByTicketId(
      { ticketId: req.params.ticketId, closedBy, reason },
      io
    );

    res.json({
      success: true,
      ticketId: conversation.externalTicketId,
      conversationId: conversation._id,
      status: conversation.status,
      closedAt: conversation.metadata?.closedAt || null,
      message: 'Conversación cerrada. El historial se conserva en la base de datos.'
    });
  });

  /** Presencia del ciudadano de un ticket */
  expressApp.get('/api/integrations/presence/ticket/:ticketId', async (req, res) => {
    await authenticateRequest(req, { allowQuery: true, invalidStatus: 401 });

    const conversation = await Conversation.findOne({ externalTicketId: req.params.ticketId })
      .select('isOnline updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada para el ticket especificado' });
    }

    res.json({
      ticketId: req.params.ticketId,
      conversationId: conversation._id,
      isOnline: !!conversation.isOnline,
      lastUpdatedAt: conversation.updatedAt
    });
  });

  /**
   * SLA: conversaciones activas sin mensajes del ciudadano en las últimas X horas
   * (o sin mensajes y creadas hace más de X horas).
   */
  expressApp.get('/api/integrations/conversations/overdue', async (req, res) => {
    await authenticateRequest(req, { allowQuery: true, invalidStatus: 401 });

    const hours = clampInt(req.query.hours, { min: 1, max: OVERDUE_MAX_HOURS, fallback: 72 });
    const limit = clampInt(req.query.limit, { min: 1, max: 500, fallback: 100 });
    const thresholdDate = new Date(Date.now() - hours * 60 * 60 * 1000);

    const overdue = await Conversation.find({
      status: 'active',
      $or: [
        { lastCustomerMessageAt: { $lte: thresholdDate } },
        { lastCustomerMessageAt: null, createdAt: { $lte: thresholdDate } }
      ]
    })
      .populate('platformId', 'name')
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    res.json({
      ok: true,
      hoursThreshold: hours,
      count: overdue.length,
      conversations: overdue
    });
  });

  // Campos nuevos son aditivos; ok/service/version se mantienen.
  expressApp.get('/api/integrations/health', async (req, res) => {
    const mongo = await checkMongoHealth();
    const healthy = mongo.ok;
    const payload = {
      ok: healthy,
      service: 'chat-multiservicio-connector',
      version: '1.0.0',
      uptimeSec: getUptimeSec(),
      startedAt: getStartedAtIso(),
      mongo,
      timestamp: new Date().toISOString()
    };

    if (!healthy) {
      logger.warn('health_check_unhealthy', { mongo });
      return res.status(503).json(payload);
    }

    return res.json(payload);
  });
}

module.exports = {
  authenticateRequest,
  linkConversation,
  resolveConversationForClient,
  deliverAgentMessage,
  deliverCustomerMessage,
  closeConversationByTicketId,
  registerIntegrationRoutes,
  isMaracaiboPlatform,
  isTicketsPlatform
};
