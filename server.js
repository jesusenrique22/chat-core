const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Validación estricta antes de cargar el resto (sin defaults para vars críticas)
const { MONGODB_URI } = require('./src/lib/env');
const { connectMongo, registerShutdownHandlers } = require('./src/lib/mongo');
const logger = require('./src/lib/logger');

const PORT = process.env.PORT || 4000;

const { initPublicBaseUrl } = require('./src/lib/publicUrl');
initPublicBaseUrl(PORT);

// Importar modelos
const Platform = require('./src/models/Platform');
const Conversation = require('./src/models/Conversation');
const {
  resolveConversationForClient,
  registerIntegrationRoutes
} = require('./src/lib/integrations');
const {
  DELIVERY_CHANNELS,
  JOIN_CHAT_MESSAGE_LIMIT,
  recordMessage,
  markMessagesReadByCustomer,
  getConversationHistory,
  mapMessagesToData,
  fetchRecentMessagesForConversation,
  fetchOlderMessagesForConversation
} = require('./src/lib/messageStore');
const { validateMessagePayload } = require('./src/lib/messageHelpers');
const {
  createCorsOriginHandler,
  isOriginAllowedForPlatform,
  syncMaracaiboOriginsOnStartup,
  invalidatePlatformOriginsCache,
  logShareUrls
} = require('./src/lib/cors');
const { registerUploadRoutes } = require('./src/lib/uploads');
const { AGENTS_DASHBOARD_ROOM } = require('./src/lib/socketRooms');
const { shouldThrottleSocketEvent, shouldRateLimitSocketEvent } = require('./src/lib/throttle');

const SEND_MESSAGE_MAX_PER_MIN = Number(process.env.SEND_MESSAGE_MAX_PER_MIN) || 10;

async function seedPlatformsIfEmpty() {
  try {
    const platformCount = await Platform.countDocuments();
    if (platformCount === 0) {
      logger.info('auto_seed_platforms_start');
      const testPlatforms = [
        {
          name: 'Servicios Maracaibo',
          apiKey: 'maracaibo_secret_key_2026',
          allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', '*']
        },
        {
          name: 'Sistema de Tickets',
          apiKey: 'tickets_secret_key_2026',
          allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', '*']
        }
      ];
      await Platform.insertMany(testPlatforms);
      logger.info('auto_seed_platforms_done');
    }
    await syncMaracaiboOriginsOnStartup();
    invalidatePlatformOriginsCache();
  } catch (seedErr) {
    logger.error('auto_seed_failed', { error: seedErr.message });
  }
}

const expressApp = express();
const server = http.createServer(expressApp);

  expressApp.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));

  // CORS: Express (widget.js, API REST, socket.io.js) — permisivo según .env / plataformas
  const corsOriginHandler = createCorsOriginHandler();
  expressApp.use(cors({
    origin: corsOriginHandler,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key']
  }));

  expressApp.use(express.json({ limit: '1mb' }));

  const integrationsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_INTEGRATIONS) || 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones. Intente de nuevo en un minuto.' }
  });

  const conversationsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_CONVERSATIONS) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones. Intente de nuevo en un minuto.' }
  });

  const uploadsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_UPLOADS) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas subidas. Intente de nuevo en un minuto.' }
  });

  expressApp.use('/api/integrations', integrationsLimiter);
  expressApp.use('/api/conversations', conversationsLimiter);
  expressApp.use('/api/uploads', uploadsLimiter);

  // ============================================
  // Endpoints REST (monitoreo / agentes)
  // ============================================

  // GET /api/conversations: Conversaciones activas (respuesta = array, mismo contrato)
  expressApp.get('/api/conversations', async (req, res) => {
    try {
      const conversations = await Conversation.find({ status: 'active' })
        .populate('platformId')
        .sort({ updatedAt: -1 });
      res.json(conversations);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/conversations/:id/messages: Historial de mensajes de un chat específico
  expressApp.get('/api/conversations/:id/messages', async (req, res) => {
    try {
      const { id } = req.params;
      const history = await getConversationHistory(id, req.query);
      res.json(history.messages);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // GET /api/conversations/:id/history: Historial estructurado con trazabilidad
  expressApp.get('/api/conversations/:id/history', async (req, res) => {
    try {
      const history = await getConversationHistory(req.params.id, req.query);
      res.json(history);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // GET /api/integrations/presence/ticket/:ticketId: Consultar presencia del cliente de un ticket por API REST
  expressApp.get('/api/integrations/presence/ticket/:ticketId', async (req, res) => {
    const { ticketId } = req.params;
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;

    if (!apiKey) {
      return res.status(401).json({ error: 'API Key requerida' });
    }

    try {
      const platform = await Platform.findOne({ apiKey });
      if (!platform) {
        return res.status(401).json({ error: 'API Key no autorizada' });
      }

      // Buscar conversación activa o la más reciente vinculada al ticket
      const conversation = await Conversation.findOne({ externalTicketId: ticketId })
        .sort({ updatedAt: -1 });

      if (!conversation) {
        return res.status(404).json({ error: 'Conversación no encontrada para el ticket especificado' });
      }

      res.json({
        ticketId,
        conversationId: conversation._id,
        isOnline: !!conversation.isOnline,
        lastUpdatedAt: conversation.updatedAt
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Subida de imágenes → bucket remoto (MongoDB solo guarda la URL)
  registerUploadRoutes(expressApp);

  // Servir contenido estático (widget.js y demos) desde public/
  expressApp.use(express.static('public'));

  // ============================================
  // Configuración de Socket.io
  // ============================================
  const recoveryMs =
    Number(process.env.SOCKET_RECOVERY_MS) ||
    (process.env.NODE_ENV === 'production' ? 30 * 1000 : 2 * 60 * 1000);

  const io = new Server(server, {
    connectionStateRecovery: {
      maxDisconnectionDuration: recoveryMs,
      // Re-validar auth de plataforma (/client) tras recovery
      skipMiddlewares: false
    },
    cors: {
      origin: corsOriginHandler,
      methods: ['GET', 'POST', 'OPTIONS'],
      credentials: true
    }
  });

  const clientNamespace = io.of('/client');
  const agentNamespace = io.of('/agent');

  registerIntegrationRoutes(expressApp, io);

  // Middleware de validación de API Key y CORS para Clientes
  clientNamespace.use(async (socket, nextMiddleware) => {
    const { apiKey, customerId, customerName, ticketId } = socket.handshake.auth || socket.handshake.query;
    const origin = socket.handshake.headers.origin;

    if (!apiKey) {
      return nextMiddleware(new Error('Autenticación fallida: API Key requerida'));
    }
    if (!customerId || !customerName) {
      return nextMiddleware(new Error('Autenticación fallida: Datos de cliente incompletos'));
    }

    try {
      const platform = await Platform.findOne({ apiKey });
      if (!platform) {
        return nextMiddleware(new Error('Autenticación fallida: API Key no autorizada'));
      }

      // Validar origen según plataforma + reglas globales (VPN, .env)
      if (origin && !isOriginAllowedForPlatform(origin, platform)) {
        logger.warn('socket_cors_blocked', { origin, platform: platform.name });
        return nextMiddleware(new Error(`Autenticación de origen bloqueada por CORS: ${origin}`));
      }

      // Almacenar referencias en el objeto socket
      socket.platform = platform;
      socket.customerId = customerId;
      socket.customerName = customerName;
      socket.ticketId = ticketId ? String(ticketId).trim() : null;
      return nextMiddleware();
    } catch (err) {
      return nextMiddleware(new Error('Error interno del servidor en autenticación'));
    }
  });

  // ============================================
  // Eventos: Clientes (/client)
  // ============================================
  clientNamespace.on('connection', (socket) => {
    logger.info('client_connected', {
      customerName: socket.customerName,
      platform: socket.platform.name
    });

    socket.on('join_chat', async (callback) => {
      try {
        const conversation = await resolveConversationForClient(socket, socket.ticketId);
        const roomId = conversation._id.toString();

        socket.join(roomId);
        socket.conversationId = roomId;

        const messages = await fetchRecentMessagesForConversation(conversation._id);
        const mapped = mapMessagesToData(messages);

        if (typeof callback === 'function') {
          callback({
            success: true,
            conversationId: conversation._id,
            externalTicketId: conversation.externalTicketId || null,
            messages: mapped,
            hasMore: mapped.length >= JOIN_CHAT_MESSAGE_LIMIT
          });
        }

        // Presencia + lecturas + emit en paralelo (después del callback = join más rápido)
        const populatePromise =
          conversation.platformId && typeof conversation.platformId === 'object' && conversation.platformId.name
            ? Promise.resolve(conversation)
            : conversation.populate('platformId');

        const [, populatedConv] = await Promise.all([
          Conversation.findByIdAndUpdate(conversation._id, { isOnline: true }),
          populatePromise,
          markMessagesReadByCustomer(conversation._id, io) // no-op si no hay unread
        ]);

        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', populatedConv);

        const presencePayload = {
          conversationId: roomId,
          online: true,
          customerName: socket.customerName
        };
        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('client_presence', presencePayload);
        agentNamespace.to(roomId).emit('client_presence', presencePayload);
      } catch (err) {
        logger.error('join_chat_failed', { error: err.message });
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    socket.on('load_older_messages', async (data, callback) => {
      try {
        if (typeof data === 'function') {
          callback = data;
          data = {};
        }
        const conversationId = socket.conversationId;
        if (!conversationId) {
          return callback && callback({ success: false, error: 'No hay conversación activa' });
        }
        const before = data?.before;
        if (!before) {
          return callback && callback({ success: false, error: 'before (timestamp) es requerido' });
        }

        const { messages, hasMore } = await fetchOlderMessagesForConversation(
          conversationId,
          before,
          data?.limit || JOIN_CHAT_MESSAGE_LIMIT
        );

        if (typeof callback === 'function') {
          callback({
            success: true,
            messages: mapMessagesToData(messages),
            hasMore
          });
        }
      } catch (err) {
        logger.error('load_older_messages_failed', { error: err.message });
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    socket.on('send_message', async (data, callback) => {
      try {
        if (shouldRateLimitSocketEvent(socket, 'send_message', SEND_MESSAGE_MAX_PER_MIN, 60_000)) {
          return callback && callback({
            success: false,
            error: `Límite de mensajes alcanzado (máx ${SEND_MESSAGE_MAX_PER_MIN}/min)`
          });
        }

        const payload = validateMessagePayload(data);
        if (payload.error) {
          return callback && callback({ success: false, error: payload.error });
        }

        let conversationId = socket.conversationId;
        if (!conversationId) {
          return callback && callback({ success: false, error: 'No se ha unido a un chat activo. Ejecute join_chat primero.' });
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

        if (typeof callback === 'function') {
          callback({ success: true, message: result.message });
        }
      } catch (err) {
        logger.error('client_send_message_failed', { error: err.message });
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // El ciudadano vio los mensajes del agente (chat abierto o mensaje nuevo en pantalla)
    socket.on('mark_messages_read', async (data, callback) => {
      try {
        if (typeof data === 'function') {
          callback = data;
          data = {};
        }

        const conversationId = socket.conversationId;
        if (!conversationId) {
          return callback && callback({ success: false, error: 'No hay conversación activa' });
        }

        const messageId = data?.messageId ? String(data.messageId).trim() : undefined;
        const result = await markMessagesReadByCustomer(conversationId, io, { messageId });
        if (typeof callback === 'function') {
          callback({ success: true, marked: !!result, ...(result || {}) });
        }
      } catch (err) {
        logger.error('mark_messages_read_failed', { error: err.message });
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
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

    socket.on('disconnect', (reason) => {
      const conversationId = socket.conversationId;
      if (conversationId) {
        // Limpiar indicador de typing
        const typingPayload = {
          conversationId,
          senderType: 'customer',
          displayName: socket.customerName,
          isTyping: false
        };
        agentNamespace.to(conversationId).emit('user_typing', typingPayload);
        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_typing', typingPayload);

        const presencePayload = {
          conversationId,
          online: false,
          customerName: socket.customerName
        };
        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('client_presence', presencePayload);
        agentNamespace.to(conversationId).emit('client_presence', presencePayload);

        // Marcar presencia como offline en MongoDB en segundo plano
        Conversation.findByIdAndUpdate(conversationId, { isOnline: false })
          .catch((err) => logger.error('presence_offline_update_failed', { error: err.message }));
      }
      logger.info('client_disconnected', {
        customerName: socket.customerName,
        reason
      });
    });
  });

  // ============================================
  // Eventos: Agentes (/agent)
  // ============================================
  agentNamespace.on('connection', (socket) => {
    socket.join(AGENTS_DASHBOARD_ROOM);
    logger.info('agent_connected');

    socket.on('agent_join', (data) => {
      const { conversationId } = data;
      if (conversationId) {
        socket.rooms.forEach((room) => {
          if (
            room !== socket.id &&
            room !== conversationId &&
            room !== AGENTS_DASHBOARD_ROOM
          ) {
            socket.leave(room);
          }
        });
        socket.join(conversationId);
        logger.debug('agent_joined_room', { conversationId });
      }
    });

    socket.on('agent_send_message', async (data, callback) => {
      try {
        if (shouldRateLimitSocketEvent(socket, 'send_message', SEND_MESSAGE_MAX_PER_MIN, 60_000)) {
          return callback && callback({
            success: false,
            error: `Límite de mensajes alcanzado (máx ${SEND_MESSAGE_MAX_PER_MIN}/min)`
          });
        }

        const { conversationId } = data;
        if (!conversationId) {
          return callback && callback({ success: false, error: 'conversationId es requerido' });
        }

        const payload = validateMessagePayload(data);
        if (payload.error) {
          return callback && callback({ success: false, error: payload.error });
        }

        const result = await recordMessage(
          {
            conversationId,
            senderType: 'agent',
            messageType: payload.messageType,
            content: payload.content,
            attachment: payload.attachment,
            senderName: 'Agente',
            deliveryChannel: DELIVERY_CHANNELS.SOCKET_AGENT
          },
          io
        );

        if (typeof callback === 'function') {
          callback({ success: true, message: result.message });
        }
      } catch (err) {
        logger.error('agent_send_message_failed', { error: err.message });
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // Indicador: agente está escribiendo
    socket.on('agent_typing', (data) => {
      const { conversationId, isTyping } = data || {};
      if (!conversationId) return;
      if (isTyping && shouldThrottleSocketEvent(socket, 'agent_typing', 2000)) return;
      clientNamespace.to(conversationId).emit('user_typing', {
        conversationId,
        senderType: 'agent',
        displayName: 'Agente de soporte',
        isTyping: !!isTyping
      });
    });

    // Evento: close_conversation - Finalizar la conversación
    socket.on('close_conversation', async (data, callback) => {
      try {
        const { conversationId } = data;
        if (!conversationId) {
          return callback && callback({ success: false, error: 'ID de conversación inválido' });
        }

        // Cerrar estado en base de datos
        const conversation = await Conversation.findByIdAndUpdate(
          conversationId,
          { status: 'closed' },
          { new: true }
        ).populate('platformId');

        // Emitir notificaciones de cierre a clientes y agentes
        clientNamespace.to(conversationId).emit('conversation_closed', { conversationId });
        agentNamespace.to(conversationId).emit('conversation_closed', { conversationId });
        
        // Notificar cambio de lista general (los agentes remueven o archivan el chat)
        agentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('conversation_updated', conversation);

        if (typeof callback === 'function') {
          callback({ success: true, conversation });
        }
      } catch (err) {
        logger.error('close_conversation_failed', { error: err.message });
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    socket.on('disconnect', () => {
      logger.info('agent_disconnected');
    });
  });

  async function bootstrap() {
    await connectMongo(MONGODB_URI);
    await seedPlatformsIfEmpty();

    await new Promise((resolve, reject) => {
      server.listen(PORT, '0.0.0.0', (err) => {
        if (err) {
          if (err.code === 'EADDRINUSE') {
            logger.error('port_in_use', { port: PORT });
          }
          return reject(err);
        }
        resolve();
      });
    });

    initPublicBaseUrl(PORT);
    logShareUrls(PORT);
    logger.info('server_ready', {
      port: PORT,
      bucketFolder: process.env.BUCKET_FOLDER,
      nodeEnv: process.env.NODE_ENV || 'development'
    });

    // PM2 wait_ready: el proceso está listo para recibir tráfico
    if (typeof process.send === 'function') {
      process.send('ready');
    }

    registerShutdownHandlers(server, io);
  }

  bootstrap().catch((err) => {
    logger.error('bootstrap_failed', { error: err.message });
    process.exit(1);
  });
