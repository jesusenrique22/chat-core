/**
 * Adaptador Redis para Socket.io (opcional, se activa con REDIS_URL).
 *
 * Sin Redis, cada proceso solo conoce SUS sockets: con PM2 cluster o varias réplicas,
 * un mensaje recibido en la instancia A no llega a un agente conectado en la instancia B.
 * Con REDIS_URL, las emisiones (rooms, fetchSockets) se propagan entre instancias.
 *
 * Nota: con varias instancias, los clientes deben usar transports: ['websocket']
 * o el balanceador debe tener sticky sessions (el long-polling lo requiere).
 */

const logger = require('./logger');

async function attachRedisAdapter(io, redisUrl) {
  if (!redisUrl) {
    logger.info('socket_adapter', { type: 'memory', note: 'una sola instancia' });
    return null;
  }

  const { createClient } = require('redis');
  const { createAdapter } = require('@socket.io/redis-adapter');

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => logger.error('redis_pub_error', { error: err.message }));
  subClient.on('error', (err) => logger.error('redis_sub_error', { error: err.message }));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('socket_adapter', { type: 'redis' });

  return async () => {
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
  };
}

module.exports = { attachRedisAdapter };
