/**
 * Errores HTTP tipados + manejador central de Express.
 * Los 4xx devuelven su mensaje; los 5xx devuelven un mensaje genérico (sin filtrar internos).
 */

const logger = require('./logger');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const unauthorized = (msg) => new HttpError(401, msg);
const forbidden = (msg) => new HttpError(403, msg);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** Normaliza errores de Mongoose/Mongo a HttpError cuando son culpa del cliente. */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err?.name === 'CastError') return badRequest(`Valor inválido para ${err.path}`);
  if (err?.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    return badRequest(first?.message || 'Datos inválidos');
  }
  if (err?.code === 11000) return conflict('Registro duplicado');
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, err.message);
  }
  return null;
}

/** Mensaje seguro para enviar al cliente (sockets y REST). */
function publicMessage(err) {
  const httpErr = toHttpError(err);
  if (httpErr && httpErr.status < 500) return httpErr.message;
  return 'Error interno del servidor';
}

// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, _next) {
  if (err?.message?.startsWith('CORS bloqueado')) {
    return res.status(403).json({ success: false, error: err.message });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Payload demasiado grande' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'JSON inválido' });
  }

  const httpErr = toHttpError(err);
  const status = httpErr?.status || 500;

  if (status >= 500) {
    logger.error('http_unhandled_error', {
      method: req.method,
      path: req.path,
      error: err?.message,
      stack: err?.stack
    });
  }

  return res.status(status).json({
    success: false,
    error: status >= 500 ? 'Error interno del servidor' : httpErr.message
  });
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  toHttpError,
  publicMessage,
  errorMiddleware
};
