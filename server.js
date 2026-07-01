const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config(); // Load .env variables

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat_multiservicio';

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
  recordMessage,
  getConversationHistory,
  mapMessagesToData,
  fetchMessagesForConversation
} = require('./src/lib/messageStore');
const { validateMessagePayload } = require('./src/lib/messageHelpers');
const {
  createCorsOriginHandler,
  isOriginAllowedForPlatform,
  syncMaracaiboOriginsOnStartup,
  logShareUrls
} = require('./src/lib/cors');
const { registerUploadRoutes, UPLOAD_DIR } = require('./src/lib/uploads');

// Función para conectar a la DB con fallback in-memory y auto-siembra
async function connectDB() {
  let uri = MONGODB_URI;

  try {
    // Intentar conexión a la DB local o configurada
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
    console.log('✅ Conectado a MongoDB local/remoto');
  } catch (err) {
    console.log('⚠️ MongoDB local no está corriendo en 27017. Levantando MongoDB en memoria...');
    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      const mongoServer = await MongoMemoryServer.create();
      uri = mongoServer.getUri();
      await mongoose.connect(uri);
      console.log(`✅ Conectado a MongoDB en memoria: ${uri}`);
    } catch (memErr) {
      console.error('❌ Error fatal al iniciar MongoDB en memoria:', memErr);
      process.exit(1);
    }
  }

  // Auto-siembra si la base de datos está vacía
  try {
    const platformCount = await Platform.countDocuments();
    if (platformCount === 0) {
      console.log('🌱 Base de datos vacía. Sembrando plataformas de prueba...');
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
      console.log('✅ Plataformas sembradas automáticamente.');
    }
    await syncMaracaiboOriginsOnStartup();
  } catch (seedErr) {
    console.error('❌ Error en auto-siembra:', seedErr);
  }
}

connectDB();

const expressApp = express();
const server = http.createServer(expressApp);

  // CORS: Express (widget.js, API REST, socket.io.js)
  const corsOriginHandler = createCorsOriginHandler();
  expressApp.use(cors({
    origin: corsOriginHandler,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key']
  }));

  expressApp.use(express.json());

  // ============================================
  // Endpoints REST requeridos
  // ============================================

  // GET /api/conversations: Historial de chats activos para el dashboard de agentes
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

  // Subida de imágenes (archivos en disco; MongoDB solo guarda URL)
  registerUploadRoutes(expressApp);
  expressApp.use('/uploads', express.static(UPLOAD_DIR));

  // Servir contenido estático (widget.js y assets) desde la carpeta public
  expressApp.use(express.static('public'));
  // No se delegan rutas a Next.js aquí, el dashboard corre por separado

  // ============================================
  // Configuración de Socket.io (Conexión Súper Persistente)
  // ============================================
  const io = new Server(server, {
    // Habilitar Connection State Recovery
    // Si el cliente se desconecta brevemente, el servidor retiene su búfer y se recupera el estado sin perder paquetes.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutos
      skipMiddlewares: true
    },
    cors: {
      origin: corsOriginHandler,
      methods: ['GET', 'POST', 'OPTIONS'],
      credentials: true
    }
  });

  // Declaración de namespaces separados para Clientes y Agentes
  const clientNamespace = io.of('/client');
  const agentNamespace = io.of('/agent');

  // API del conector (Tickets ↔ Maracaibo)
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
        console.warn(`⛔ Socket CORS bloqueado: ${origin} (plataforma: ${platform.name})`);
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
    console.log(`🔌 Cliente "${socket.customerName}" conectado desde [${socket.platform.name}]`);

    // Evento: join_chat - Crea o recupera una conversación persistente
    socket.on('join_chat', async (callback) => {
      try {
        const conversation = await resolveConversationForClient(socket, socket.ticketId);

        socket.join(conversation._id.toString());
        socket.conversationId = conversation._id.toString();

        const { messages } = await fetchMessagesForConversation(conversation._id);

        if (typeof callback === 'function') {
          callback({
            success: true,
            conversationId: conversation._id,
            externalTicketId: conversation.externalTicketId || null,
            messages: mapMessagesToData(messages)
          });
        }

        // Marcar presencia como online en MongoDB
        await Conversation.findByIdAndUpdate(conversation._id, { isOnline: true });

        // Notificar globalmente a los agentes en el dashboard para añadir o actualizar la conversación en su lista
        const populatedConv = await Conversation.findById(conversation._id).populate('platformId');
        agentNamespace.emit('conversation_updated', populatedConv);

        // Notificar presencia: el cliente está en línea
        const presencePayload = {
          conversationId: conversation._id.toString(),
          online: true,
          customerName: socket.customerName
        };
        agentNamespace.to(conversation._id.toString()).emit('client_presence', presencePayload);
        agentNamespace.emit('client_presence_global', presencePayload);

      } catch (err) {
        console.error('Error en join_chat:', err);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // Evento: send_message - Envía mensaje del cliente al agente
    socket.on('send_message', async (data, callback) => {
      try {
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
        console.error('Error en send_message cliente:', err);
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
      const payload = {
        conversationId,
        senderType: 'customer',
        displayName: socket.customerName,
        isTyping
      };
      agentNamespace.to(conversationId).emit('user_typing', payload);
      agentNamespace.emit('conversation_typing', payload);
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
        agentNamespace.emit('conversation_typing', typingPayload);

        // Notificar presencia: el cliente se desconectó
        const presencePayload = {
          conversationId,
          online: false,
          customerName: socket.customerName
        };
        agentNamespace.to(conversationId).emit('client_presence', presencePayload);
        agentNamespace.emit('client_presence_global', presencePayload);

        // Marcar presencia como offline en MongoDB en segundo plano
        Conversation.findByIdAndUpdate(conversationId, { isOnline: false })
          .catch(err => console.error('Error al actualizar presencia offline en DB:', err));
      }
      console.log(`🔌 Cliente desvinculado: "${socket.customerName}" (Razón: ${reason})`);
    });
  });

  // ============================================
  // Eventos: Agentes (/agent)
  // ============================================
  agentNamespace.on('connection', (socket) => {
    console.log('👷 Agente conectado al Dashboard Central');

    // Evento: agent_join - Agente se suscribe a una sala de chat de cliente
    socket.on('agent_join', (data) => {
      const { conversationId } = data;
      if (conversationId) {
        // Limpiar suscripciones previas para no duplicar flujos de mensajes en salas incorrectas
        socket.rooms.forEach(room => {
          if (room !== socket.id && room !== conversationId) {
            socket.leave(room);
          }
        });
        socket.join(conversationId);
        console.log(`👷 Agente escuchando la sala: ${conversationId}`);
      }
    });

    // Evento: agent_send_message - Respuesta del agente al cliente
    socket.on('agent_send_message', async (data, callback) => {
      try {
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
            senderName: 'Agente (dashboard)',
            deliveryChannel: DELIVERY_CHANNELS.SOCKET_AGENT
          },
          io
        );

        if (typeof callback === 'function') {
          callback({ success: true, message: result.message });
        }
      } catch (err) {
        console.error('Error en agent_send_message:', err);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // Indicador: agente está escribiendo
    socket.on('agent_typing', (data) => {
      const { conversationId, isTyping } = data || {};
      if (!conversationId) return;
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
        agentNamespace.emit('conversation_updated', conversation);

        if (typeof callback === 'function') {
          callback({ success: true, conversation });
        }
      } catch (err) {
        console.error('Error en close_conversation:', err);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('👷 Agente desconectado del Dashboard');
    });
  });

  server.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Puerto ${PORT} en uso. Detén el proceso anterior: kill $(lsof -t -i :${PORT})`);
      }
      throw err;
    }
    console.log(`🚀 Conector de chat listo en http://0.0.0.0:${PORT}`);
    const publicBase = initPublicBaseUrl(PORT);
    logShareUrls(PORT);
    console.log(`🖼️  URLs de imágenes:  ${publicBase}/uploads/...`);
    if (!process.env.PUBLIC_BASE_URL) {
      console.log('   (auto-detectada por IP LAN; fija con PUBLIC_BASE_URL en .env si cambia el Wi‑Fi)');
    }
    console.log('');
  });
