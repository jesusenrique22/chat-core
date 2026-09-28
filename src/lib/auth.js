/**
 * Autenticación de plataformas (API Key) para REST y Socket.io.
 *
 * - Caché en memoria de API Keys → evita una consulta a Mongo por request/conexión.
 * - AUTH_ENFORCE=true exige credenciales en rutas de agente (/agent, /api/conversations,
 *   bandeja de citas) y de ciudadano (citas). Con false (default) quedan abiertas como antes,
 *   pero si se envía una key válida se adjunta igualmente a req.platform / socket.platform.
 * - CLIENT_TOKEN_SECRET (opcional): el socket /client debe enviar token = HMAC-SHA256(secret, "customerId:ticketId").
 */

const crypto = require('crypto');
const Platform = require('../models/Platform');
const { asString } = require('./validate');
const { unauthorized, forbidden } = require('./errors');
const logger = require('./logger');

const CACHE_TTL_MS = Number(process.env.PLATFORM_CACHE_TTL_MS) || 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 1000;
const MAX_CACHE_ENTRIES = 1000;

const keyCache = new Map(); // apiKey → { platform|null, expiresAt }
let maracaiboCache = { platform: null, expiresAt: 0 };

function isAuthEnforced() {
  return process.env.AUTH_ENFORCE === 'true';
}

function getAgentApiKeys() {
  return (process.env.AGENT_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isMaracaiboPlatform(platform) {
  return !!platform?.name && platform.name.toLowerCase().includes('servicios maracaibo');
}

function isTicketsPlatform(platform) {
  return !!platform?.name && platform.name.toLowerCase().includes('ticket');
}

function invalidatePlatformCache() {
  keyCache.clear();
  maracaiboCache = { platform: null, expiresAt: 0 };
}

/** Busca plataforma por API Key (con caché). Devuelve null si no existe. */
async function findPlatformByApiKey(rawKey) {
  const apiKey = asString(rawKey, { max: 512 });
  if (!apiKey) return null;

  const now = Date.now();
  const cached = keyCache.get(apiKey);
  if (cached && cached.expiresAt > now) return cached.platform;

  const platform = await Platform.findOne({ apiKey }).lean();
  if (keyCache.size >= MAX_CACHE_ENTRIES) keyCache.clear();
  keyCache.set(apiKey, {
    platform,
    expiresAt: now + (platform ? CACHE_TTL_MS : NEGATIVE_TTL_MS)
  });
  return platform;
}

async function getMaracaiboPlatform() {
  const now = Date.now();
  if (maracaiboCache.platform && maracaiboCache.expiresAt > now) {
    return maracaiboCache.platform;
  }
  const platform = await Platform.findOne({ name: /servicios maracaibo/i }).lean();
  if (!platform) {
    const err = new Error('Plataforma Servicios Maracaibo no configurada');
    err.status = 500;
    throw err;
  }
  maracaiboCache = { platform, expiresAt: now + CACHE_TTL_MS };
  return platform;
}

/**
 * Lee la API Key: header X-Api-Key, Authorization: Bearer, y opcionalmente ?apiKey=.
 */
function getApiKeyFromRequest(req, { allowQuery = false } = {}) {
  const header = asString(req.headers['x-api-key'], { max: 512 });
  if (header) return header;
  const bearer = asString((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), { max: 512 });
  if (bearer) return bearer;
  if (allowQuery) return asString(req.query?.apiKey, { max: 512 });
  return null;
}

/**
 * Autentica una request REST. Lanza 401 (sin key) / invalidStatus (key inválida).
 */
async function authenticateRequest(req, { allowQuery = false, invalidStatus = 403 } = {}) {
  const apiKey = getApiKeyFromRequest(req, { allowQuery });
  if (!apiKey) throw unauthorized('API Key requerida (header X-Api-Key)');

  const platform = await findPlatformByApiKey(apiKey);
  if (!platform) {
    const err = new Error('API Key no autorizada');
    err.status = invalidStatus;
    throw err;
  }
  return platform;
}

/** ¿La key corresponde a un agente? (plataforma Sistema de Tickets o AGENT_API_KEYS) */
async function resolveAgentIdentity(rawKey) {
  const apiKey = asString(rawKey, { max: 512 });
  if (!apiKey) return null;

  if (getAgentApiKeys().some((k) => safeEqual(k, apiKey))) {
    return { kind: 'agent_key' };
  }
  const platform = await findPlatformByApiKey(apiKey);
  if (platform && isTicketsPlatform(platform)) {
    return { kind: 'platform', platform };
  }
  return null;
}

/**
 * Middleware Express.
 * @param {'agent'|'platform'} level agent = solo agentes; platform = cualquier plataforma registrada.
 */
function requireAuth(level = 'platform') {
  return async (req, _res, next) => {
    const apiKey = getApiKeyFromRequest(req, { allowQuery: true });
    const enforce = isAuthEnforced();

    if (!apiKey) {
      return next(enforce ? unauthorized('API Key requerida (header X-Api-Key)') : undefined);
    }

    if (level === 'agent') {
      const identity = await resolveAgentIdentity(apiKey);
      if (identity) {
        req.agent = identity;
        req.platform = identity.platform || null;
        return next();
      }
      return next(enforce ? forbidden('API Key sin permisos de agente') : undefined);
    }

    const platform = await findPlatformByApiKey(apiKey);
    if (platform) {
      req.platform = platform;
      return next();
    }
    return next(enforce ? forbidden('API Key no autorizada') : undefined);
  };
}

/** Middleware Socket.io para /agent. */
async function agentSocketAuth(socket, next) {
  const auth = socket.handshake.auth || {};
  const apiKey = asString(auth.apiKey, { max: 512 }) || asString(socket.handshake.headers['x-api-key'], { max: 512 });

  try {
    const identity = apiKey ? await resolveAgentIdentity(apiKey) : null;
    if (identity) {
      socket.agent = identity;
      socket.agentName = asString(auth.agentName, { max: 120 }) || 'Agente';
      return next();
    }
    if (isAuthEnforced()) {
      logger.warn('agent_socket_auth_rejected', { hasKey: !!apiKey, ip: socket.handshake.address });
      return next(new Error('Autenticación fallida: API Key de agente requerida'));
    }
    socket.agent = null;
    socket.agentName = 'Agente';
    return next();
  } catch (err) {
    logger.error('agent_socket_auth_error', { error: err.message });
    return next(new Error('Error interno del servidor en autenticación'));
  }
}

/** Firma esperada para el token de cliente. Útil para que el backend de Maracaibo la genere. */
function signClientToken(customerId, ticketId = '') {
  return crypto
    .createHmac('sha256', process.env.CLIENT_TOKEN_SECRET || '')
    .update(`${customerId}:${ticketId || ''}`)
    .digest('hex');
}

/** true si no hay CLIENT_TOKEN_SECRET configurado o si el token es válido. */
function verifyClientToken(customerId, ticketId, token) {
  if (!process.env.CLIENT_TOKEN_SECRET) return true;
  const provided = asString(token, { max: 256 });
  if (!provided) return false;
  return safeEqual(provided, signClientToken(customerId, ticketId));
}

module.exports = {
  isAuthEnforced,
  isMaracaiboPlatform,
  isTicketsPlatform,
  invalidatePlatformCache,
  findPlatformByApiKey,
  getMaracaiboPlatform,
  getApiKeyFromRequest,
  authenticateRequest,
  resolveAgentIdentity,
  requireAuth,
  agentSocketAuth,
  signClientToken,
  verifyClientToken
};
