/**
 * Opciones de conexión Mongoose y cierre ordenado.
 */

const mongoose = require('mongoose');
const logger = require('./logger');

function getMongooseOptions() {
  const isProd = process.env.NODE_ENV === 'production';

  return {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 5,
    serverSelectionTimeoutMS:
      Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || (isProd ? 10000 : 5000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 10000,
    heartbeatFrequencyMS: 10000
  };
}

/**
 * Producción: si Mongo no responde → exit(1), sin DB en memoria.
 * Desarrollo: fallback in-memory solo si ALLOW_MEMORY_MONGO !== 'false'.
 */
async function connectMongo(uri) {
  const opts = getMongooseOptions();

  try {
    await mongoose.connect(uri, opts);
    logger.info('mongo_connected', { inMemory: false });
    return { uri, inMemory: false };
  } catch (err) {
    logger.error('mongo_connect_failed', { error: err.message });

    if (process.env.NODE_ENV === 'production') {
      logger.error('mongo_memory_forbidden_in_production');
      process.exit(1);
    }

    if (process.env.ALLOW_MEMORY_MONGO === 'false') {
      logger.error('mongo_memory_disabled');
      process.exit(1);
    }

    logger.warn('mongo_memory_fallback_starting');
    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      const mongoServer = await MongoMemoryServer.create();
      const memUri = mongoServer.getUri();
      await mongoose.connect(memUri, opts);
      logger.info('mongo_connected', { inMemory: true });
      return { uri: memUri, inMemory: true, mongoServer };
    } catch (memErr) {
      logger.error('mongo_memory_failed', { error: memErr.message });
      process.exit(1);
    }
  }
}

/**
 * Cierre graceful para pm2 reload / SIGTERM (Railway, Docker).
 * Orden: dejar de aceptar conexiones → cerrar sockets → hooks (webhooks, Redis) → Mongo.
 * @param {Array<() => Promise<void>|void>} [hooks] limpieza adicional
 */
function registerShutdownHandlers(httpServer, io, hooks = []) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    const forceTimer = setTimeout(() => {
      logger.error('shutdown_timeout_forcing_exit');
      process.exit(1);
    }, Number(process.env.SHUTDOWN_TIMEOUT_MS) || 7000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    try {
      // io.close() también cierra el servidor HTTP subyacente
      await new Promise((resolve) => {
        if (!io) return httpServer.close(() => resolve());
        io.close(() => resolve());
      });
      logger.info('http_and_sockets_closed');

      for (const hook of hooks) {
        try {
          await hook();
        } catch (e) {
          logger.error('shutdown_hook_error', { error: e.message });
        }
      }

      await mongoose.disconnect();
      logger.info('mongo_disconnected');
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (e) {
      logger.error('shutdown_error', { error: e.message });
      clearTimeout(forceTimer);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown('PM2-shutdown');
  });
}

module.exports = {
  getMongooseOptions,
  connectMongo,
  registerShutdownHandlers
};
