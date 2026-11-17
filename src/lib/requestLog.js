/**
 * Traza legible de peticiones y conexiones para depurar integraciones (LOG_HTTP_REQUESTS=true).
 * Nunca escribe API keys ni tokens: solo si vinieron o no.
 */

const enabled = () => process.env.LOG_HTTP_REQUESTS === 'true';

function print(line) {
  console.log(`${new Date().toLocaleTimeString('es-VE', { timeZone: 'America/Caracas' })}  ${line}`);
}

const yesNo = (value) => (value ? 'sí' : 'NO');

function logHttpRequests(req, res, next) {
  const startedAt = Date.now();
  const path = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    print(
      `[HTTP] ${req.method} ${path} -> ${res.statusCode} (${Date.now() - startedAt} ms)` +
        ` | api-key: ${yesNo(req.get('x-api-key'))} | token: ${yesNo(req.get('authorization'))}`
    );
  });
  next();
}

/** Peticiones y conexiones que rechaza Socket.io antes de llegar a un namespace (los 400). */
function logSocketEngine(io) {
  io.engine.on('connection_error', (err) => {
    const query = err.req?._query || {};
    print(
      `[SOCKET] RECHAZADO -> 400 "${err.message}" (code ${err.code})` +
        ` | EIO: ${query.EIO || '-'} | transport: ${query.transport || '-'} | sid: ${yesNo(query.sid)}`
    );
  });
  io.of('/client').on('connection', (socket) => {
    print(`[SOCKET] CONECTADO /client | ciudadano: ${socket.customerId} | transport: ${socket.conn.transport.name}`);
    socket.on('disconnect', (reason) => print(`[SOCKET] DESCONECTADO ${socket.customerId} | ${reason}`));
  });
}

function attachRequestLog(expressApp, io) {
  if (!enabled()) return;
  expressApp.use(logHttpRequests);
  logSocketEngine(io);
}

/** Muestra por qué se rechazó una autenticación de socket, sin cambiar el resultado. */
function traceSocketAuth(authenticate) {
  return (socket, next) =>
    authenticate(socket, (err) => {
      if (err && enabled()) print(`[SOCKET] RECHAZADO /client | ${err.message}`);
      next(err);
    });
}

module.exports = { attachRequestLog, traceSocketAuth };
