/**
 * Lógica del conector: validación de plataformas, enlace ticket ↔ chat, mensajes.
 */

const Platform = require('../models/Platform');
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

const MARACAIBO_PLATFORM_NAMES = ['servicios maracaibo'];

function isMaracaiboPlatform(platform) {
  return MARACAIBO_PLATFORM_NAMES.some((n) =>
    platform.name.toLowerCase().includes(n)
  );
}

function isTicketsPlatform(platform) {
  return platform.name.toLowerCase().includes('ticket');
}

/** Lee API Key desde header X-Api-Key o Authorization: Bearer <key> */
async function authenticateRequest(req) {
  const apiKey =
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  if (!apiKey) {
    const err = new Error('API Key requerida (header X-Api-Key)');
    err.status = 401;
    throw err;
  }

  const platform = await Platform.findOne({ apiKey });
  if (!platform) {
    const err = new Error('API Key no autorizada');
    err.status = 403;
    throw err;
  }

  return platform;
}

async function getMaracaiboPlatform() {
  const platforms = await Platform.find();
  const found = platforms.find((p) => isMaracaiboPlatform(p));
  if (!found) {
    const err = new Error('Plataforma Servicios Maracaibo no configurada');
    err.status = 500;
    throw err;
  }
  return found;
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
  if (!ticketId || !customerId || !customerName) {
    const err = new Error('ticketId, customerId y customerName son obligatorios');
    err.status = 400;
    throw err;
  }

  const maracaiboPlatform = await getMaracaiboPlatform();
  const ticketIdStr = String(ticketId).trim();

  let conversation = await Conversation.findOne({
    externalTicketId: ticketIdStr,
    status: 'active'
  });

  if (conversation) {
    conversation.customerId = customerId;
    conversation.customerName = customerName;
    conversation.sourceChannel = sourceChannel;
    conversation.metadata = { ...conversation.metadata, ...metadata };
    await conversation.save();
  } else {
    // Reabrir conversación cerrada de ESTE ticket (no otra del mismo customer)
    const closed = await Conversation.findOne({
      externalTicketId: ticketIdStr,
      status: 'closed'
    }).sort({ updatedAt: -1 });

    if (closed) {
      closed.status = 'active';
      closed.customerId = customerId;
      closed.customerName = customerName;
      closed.sourceChannel = sourceChannel;
      closed.metadata = { ...closed.metadata, ...metadata };
      await closed.save();
      conversation = closed;
    } else {
      // Ticket nuevo → conversación nueva (aunque el customerId ya tenga otros tickets)
      conversation = await Conversation.create({
        platformId: maracaiboPlatform._id,
        customerId,
        customerName,
        externalTicketId: ticketIdStr,
        sourceChannel,
        metadata,
        status: 'active'
      });
    }
  }

  return conversation.populate('platformId');
}

/**
 * Resuelve conversación para join_chat (socket cliente).
 */
async function resolveConversationForClient(socket, ticketIdFromAuth) {
  const maracaiboPlatform = isMaracaiboPlatform(socket.platform)
    ? socket.platform
    : await getMaracaiboPlatform();

  const ticketId = ticketIdFromAuth
    ? String(ticketIdFromAuth).trim()
    : null;

  if (ticketId) {
    const byTicket = await Conversation.findOne({
      externalTicketId: ticketId,
      status: 'active'
    });
    if (byTicket) {
      if (byTicket.customerId !== socket.customerId) {
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
      closedByTicket.status = 'active';
      closedByTicket.customerId = socket.customerId;
      closedByTicket.customerName = socket.customerName;
      await closedByTicket.save();
      return closedByTicket;
    }

    // Ticket sin conversación previa → crear una nueva (no reutilizar otro ticket del mismo usuario)
    return Conversation.create({
      platformId: maracaiboPlatform._id,
      customerId: socket.customerId,
      customerName: socket.customerName,
      externalTicketId: ticketId,
      sourceChannel: isMaracaiboPlatform(socket.platform) ? 'maracaibo_web' : 'maracaibo_app',
      status: 'active'
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
    const err = new Error(
      `No hay conversación activa para el ticket "${ticketId}". Ejecute POST /api/integrations/conversations/link primero.`
    );
    err.status = 404;
    throw err;
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
    const err = new Error(payload.error);
    err.status = 400;
    throw err;
  }

  const result = await recordMessage(
    {
      conversation,
      senderType: 'agent',
      messageType: payload.messageType,
      content: payload.content,
      attachment: payload.attachment,
      senderName: agentName || 'Agente de soporte',
      deliveryChannel: DELIVERY_CHANNELS.REST_TICKETS
    },
    io
  );

  const populatedConv = await Conversation.findById(conversation._id).populate('platformId');
  io.of('/agent').emit('conversation_updated', populatedConv);

  return { message: result.message, conversation: populatedConv };
}

/**
 * Guarda mensaje del ciudadano vía REST (opcional, además del socket).
 */
async function deliverCustomerMessage(
  { ticketId, customerId, content, messageType, attachment },
  io
) {
  const conversation = await findActiveConversationByTicketId(ticketId);

  if (conversation.customerId !== customerId) {
    const err = new Error('customerId no coincide con el ticket enlazado');
    err.status = 403;
    throw err;
  }

  const payload = validateMessagePayload({ messageType, content, attachment });
  if (payload.error) {
    const err = new Error(payload.error);
    err.status = 400;
    throw err;
  }

  const result = await recordMessage(
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

  return result;
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
    closedBy: closedBy || 'Agente de soporte',
    closeReason: reason || ''
  };
  await conversation.save();

  const populatedConv = await conversation.populate('platformId');

  if (io) {
    const clientNamespace = io.of('/client');
    const agentNamespace = io.of('/agent');
    clientNamespace.to(roomId).emit('conversation_closed', { conversationId: roomId });
    agentNamespace.to(roomId).emit('conversation_closed', { conversationId: roomId });
    agentNamespace.emit('conversation_updated', populatedConv);
  }

  return populatedConv;
}

function registerIntegrationRoutes(expressApp, io) {
  expressApp.post('/api/integrations/conversations/link', async (req, res) => {
    try {
      const platform = await authenticateRequest(req);
      if (!isMaracaiboPlatform(platform) && !isTicketsPlatform(platform)) {
        return res.status(403).json({ error: 'Plataforma no autorizada para enlazar conversaciones' });
      }

      const { ticketId, customerId, customerName, sourceChannel, metadata } = req.body;
      const conversation = await linkConversation({
        ticketId,
        customerId,
        customerName,
        sourceChannel: sourceChannel || 'maracaibo_app',
        metadata: metadata || {}
      });

      io.of('/agent').emit('conversation_updated', conversation);

      res.status(201).json({
        success: true,
        conversationId: conversation._id,
        externalTicketId: conversation.externalTicketId,
        customerId: conversation.customerId,
        customerName: conversation.customerName
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Sistema de Tickets → ciudadano (app Maracaibo) */
  expressApp.post('/api/integrations/messages', async (req, res) => {
    try {
      const platform = await authenticateRequest(req);
      if (!isTicketsPlatform(platform)) {
        return res.status(403).json({
          error: 'Solo la plataforma Sistema de Tickets puede enviar mensajes por esta ruta'
        });
      }

      const { ticketId, content, agentName, messageType, attachment } = req.body;
      if (!ticketId) {
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
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Ciudadano → REST (alternativa al socket); requiere API Key Maracaibo */
  expressApp.post('/api/integrations/messages/inbound', async (req, res) => {
    try {
      const platform = await authenticateRequest(req);
      if (!isMaracaiboPlatform(platform)) {
        return res.status(403).json({
          error: 'Solo Servicios Maracaibo puede enviar mensajes inbound por REST'
        });
      }

      const { ticketId, customerId, content, messageType, attachment } = req.body;
      if (!ticketId || !customerId) {
        return res.status(400).json({ error: 'ticketId y customerId son obligatorios' });
      }

      const result = await deliverCustomerMessage(
        { ticketId, customerId, content, messageType, attachment },
        io
      );

      res.status(201).json({ success: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Historial estructurado por ticketId (activo o cerrado) */
  expressApp.get('/api/integrations/conversations/:ticketId/messages', async (req, res) => {
    try {
      await authenticateRequest(req);
      const history = await getTicketHistory(req.params.ticketId, req.query);
      res.json(history);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Alias explícito de historial / trazabilidad por ticket */
  expressApp.get('/api/integrations/history/ticket/:ticketId', async (req, res) => {
    try {
      await authenticateRequest(req);
      const history = await getTicketHistory(req.params.ticketId, req.query);
      res.json(history);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /** Agente en Sistema de Tickets → cerrar conversación del ticket */
  expressApp.post('/api/integrations/conversations/:ticketId/close', async (req, res) => {
    try {
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
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  expressApp.get('/api/integrations/health', (req, res) => {
    res.json({
      ok: true,
      service: 'chat-multiservicio-connector',
      version: '1.0.0'
    });
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
