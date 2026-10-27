const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// Validación estricta antes de cargar el resto (sin defaults para vars críticas)
const { MONGODB_URI, REDIS_URL } = require('./src/lib/env');
const { connectMongo, registerShutdownHandlers } = require('./src/lib/mongo');
const logger = require('./src/lib/logger');

const PORT = process.env.PORT || 4000;

const { initPublicBaseUrl } = require('./src/lib/publicUrl');
initPublicBaseUrl(PORT);

const Platform = require('./src/models/Platform');
const Conversation = require('./src/models/Conversation');
const { registerIntegrationRoutes } = require('./src/lib/integrations');
const { registerCallRoutes } = require('./src/lib/calls');
const { getConversationHistory } = require('./src/lib/messageStore');
const {
  createCorsOriginHandler,
  getExtraOrigins,
  syncMaracaiboOriginsOnStartup,
  invalidatePlatformOriginsCache,
  logShareUrls
} = require('./src/lib/cors');
const { registerUploadRoutes } = require('./src/lib/uploads');
const { seedDepartmentsIfEmpty } = require('./src/lib/appointments');
const { registerAppointmentRoutes } = require('./src/lib/appointmentRoutes');
const { requireAuth, invalidatePlatformCache } = require('./src/lib/auth');
const { clampInt, asDate } = require('./src/lib/validate');
const { errorMiddleware } = require('./src/lib/errors');
const { startWebhookWorker, stopWebhookWorker } = require('./src/lib/webhooks');
const { attachRedisAdapter } = require('./src/lib/socketAdapter');
const { registerClientNamespace } = require('./src/sockets/clientNamespace');
const { registerAgentNamespace } = require('./src/sockets/agentNamespace');

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { error: reason?.message || String(reason), stack: reason?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { error: err.message, stack: err.stack });
  // Estado desconocido: salir y dejar que PM2/Railway reinicie
  process.exit(1);
});

/**
 * API Key para el auto-seed. En producción nunca se usan claves conocidas:
 * si falta la variable se genera una aleatoria y se registra UNA vez en el log.
 */
function resolveSeedKey(envName, devDefault) {
  if (process.env[envName]) return process.env[envName];
  if (process.env.NODE_ENV !== 'production') return devDefault;
  const generated = crypto.randomBytes(24).toString('hex');
  logger.warn('seed_generated_api_key', {
    envName,
    apiKey: generated,
    hint: `Guarda esta clave o define ${envName} antes del primer arranque`
  });
  return generated;
}

async function seedPlatformsIfEmpty() {
  try {
    const platformCount = await Platform.countDocuments();
    if (platformCount === 0) {
      logger.info('auto_seed_platforms_start');
      const origins = ['http://localhost:3000', 'http://127.0.0.1:3000', ...getExtraOrigins()];
      await Platform.insertMany([
        {
          name: 'Servicios Maracaibo',
          apiKey: resolveSeedKey('MARACAIBO_API_KEY', 'maracaibo_secret_key_2026'),
          allowedOrigins: origins
        },
        {
          name: 'Sistema de Tickets',
          apiKey: process.env.NOTIFICATIONS_API_KEY,
          allowedOrigins: origins
        }
      ]);
      logger.info('auto_seed_platforms_done');
    }
    await syncMaracaiboOriginsOnStartup();
    invalidatePlatformOriginsCache();
    invalidatePlatformCache();
  } catch (seedErr) {
    logger.error('auto_seed_failed', { error: seedErr.message });
  }
}

/** Sin Redis solo existe esta instancia: toda presencia "online" previa es obsoleta. */
async function resetStalePresence() {
  if (REDIS_URL) return;
  try {
    const { modifiedCount } = await Conversation.updateMany({ isOnline: true }, { isOnline: false });
    if (modifiedCount) logger.info('presence_reset', { count: modifiedCount });
  } catch (err) {
    logger.error('presence_reset_failed', { error: err.message });
  }
}

function buildLimiter(max, message) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: message }
  });
}

function configureExpress(expressApp, io, corsOriginHandler) {
  // nginx / proxy → X-Forwarded-For. Obligatorio para express-rate-limit (IP real del cliente).
  // 1 = un hop (Railway / nginx). Ajusta TRUST_PROXY_HOPS si hay más proxies.
  const trustProxyHops = process.env.TRUST_PROXY_HOPS;
  expressApp.set(
    'trust proxy',
    trustProxyHops === 'false' || trustProxyHops === '0'
      ? false
      : Number(trustProxyHops) > 0
        ? Number(trustProxyHops)
        : 1
  );
  expressApp.disable('x-powered-by');

  expressApp.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));

  // CORS: API REST + Socket.io
  expressApp.use(cors({
    origin: corsOriginHandler,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key']
  }));

  expressApp.use(compression());
  const bodyLimit = process.env.JSON_BODY_LIMIT || '256kb';
  expressApp.use(express.json({ limit: bodyLimit }));
  expressApp.use(express.urlencoded({ limit: bodyLimit, extended: false }));

  // Health / raíz: este servicio es solo API (sin HTML).
  const healthPayload = () => ({
    ok: true,
    service: 'chat-core',
    status: 'live',
    time: new Date().toISOString(),
  });
  expressApp.get('/', (_req, res) => res.status(200).json(healthPayload()));
  expressApp.get('/health', (_req, res) => res.status(200).json(healthPayload()));

  expressApp.use('/api/integrations', buildLimiter(
    Number(process.env.RATE_LIMIT_INTEGRATIONS) || 100,
    'Demasiadas peticiones. Intente de nuevo en un minuto.'
  ));
  expressApp.use('/api/conversations', buildLimiter(
    Number(process.env.RATE_LIMIT_CONVERSATIONS) || 60,
    'Demasiadas peticiones. Intente de nuevo en un minuto.'
  ));
  expressApp.use('/api/uploads', buildLimiter(
    Number(process.env.RATE_LIMIT_UPLOADS) || 20,
    'Demasiadas subidas. Intente de nuevo en un minuto.'
  ));

  // ============================================
  // Endpoints REST (monitoreo / agentes)
  // ============================================
  const agentAuth = requireAuth('agent');

  // GET /api/conversations: conversaciones activas (respuesta = array, mismo contrato).
  // Paginación opcional: ?limit=N&before=<updatedAt ISO>. Header X-Has-More indica si hay más.
  expressApp.get('/api/conversations', agentAuth, async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 1000, fallback: 500 });
    const before = asDate(req.query.before);
    const filter = { status: 'active' };
    if (before) filter.updatedAt = { $lt: before };

    const conversations = await Conversation.find(filter)
      .populate('platformId', 'name')
      .sort({ updatedAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = conversations.length > limit;
    res.set('X-Has-More', String(hasMore));
    res.json(hasMore ? conversations.slice(0, limit) : conversations);
  });

  // GET /api/conversations/:id/messages: Historial de mensajes de un chat específico
  expressApp.get('/api/conversations/:id/messages', agentAuth, async (req, res) => {
    const history = await getConversationHistory(req.params.id, req.query);
    res.json(history.messages);
  });

  // GET /api/conversations/:id/history: Historial estructurado con trazabilidad
  expressApp.get('/api/conversations/:id/history', agentAuth, async (req, res) => {
    const history = await getConversationHistory(req.params.id, req.query);
    res.json(history);
  });

  // Subida de imágenes → bucket remoto (MongoDB solo guarda la URL)
  registerUploadRoutes(expressApp);
  registerIntegrationRoutes(expressApp, io);
  registerCallRoutes(expressApp, io);
  registerAppointmentRoutes(expressApp, io.of('/agent'), io.of('/client'));

  expressApp.use('/api', (_req, res) => {
    res.status(404).json({ success: false, error: 'Ruta no encontrada' });
  });
  expressApp.use(errorMiddleware);
}

async function bootstrap() {
  await connectMongo(MONGODB_URI);
  await seedPlatformsIfEmpty();
  await seedDepartmentsIfEmpty();
  await resetStalePresence();

  const expressApp = express();
  const server = http.createServer(expressApp);
  const corsOriginHandler = createCorsOriginHandler();

  const recoveryMs =
    Number(process.env.SOCKET_RECOVERY_MS) ||
    (process.env.NODE_ENV === 'production' ? 30 * 1000 : 2 * 60 * 1000);

  const io = new Server(server, {
    connectionStateRecovery: {
      maxDisconnectionDuration: recoveryMs,
      // Re-validar auth de plataforma (/client) tras recovery
      skipMiddlewares: false
    },
    // Los mensajes son texto (≤4000 chars) o URLs: 1 MB por paquete era excesivo
    maxHttpBufferSize: Number(process.env.SOCKET_MAX_BUFFER_BYTES) || 256 * 1024,
    cors: {
      origin: corsOriginHandler,
      methods: ['GET', 'POST', 'OPTIONS'],
      credentials: true
    }
  });

  // El adaptador debe estar listo antes de registrar los namespaces
  const closeRedis = await attachRedisAdapter(io, REDIS_URL);

  registerClientNamespace(io);
  registerAgentNamespace(io);
  configureExpress(expressApp, io, corsOriginHandler);

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error('port_in_use', { port: PORT });
      }
      reject(err);
    });
    server.listen(PORT, '0.0.0.0', resolve);
  });

  startWebhookWorker();

  initPublicBaseUrl(PORT);
  logShareUrls(PORT);
  logger.info('server_ready', {
    port: PORT,
    bucketFolder: process.env.BUCKET_FOLDER,
    nodeEnv: process.env.NODE_ENV || 'development',
    authEnforced: process.env.AUTH_ENFORCE === 'true',
    redis: !!REDIS_URL
  });

  // PM2 wait_ready: el proceso está listo para recibir tráfico
  if (typeof process.send === 'function') {
    process.send('ready');
  }

  registerShutdownHandlers(server, io, [
    () => stopWebhookWorker(),
    ...(closeRedis ? [closeRedis] : [])
  ]);
}

bootstrap().catch((err) => {
  logger.error('bootstrap_failed', { error: err.message });
  process.exit(1);
});
