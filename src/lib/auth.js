/**
 * Autenticación de plataformas (API Key) para REST y Socket.io.
 *
 * - Caché en memoria de API Keys → evita una consulta a Mongo por request/conexión.
 * - Las rutas de agente (/agent, /api/conversations, bandeja de citas) y de plataforma (citas)
 *   exigen siempre credenciales.
 * - Agentes: API Key de agente (servidor a servidor) o token de agente firmado con
 *   AGENT_TOKEN_SECRET (lo emite el panel de tickets al agente con sesión; nunca la API Key
 *   en el navegador).
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
    try {
      const apiKey = getApiKeyFromRequest(req, { allowQuery: true });
      if (!apiKey) return next(unauthorized('API Key requerida (header X-Api-Key)'));

      if (level === 'agent') {
        const identity = await resolveAgentIdentity(apiKey);
        if (!identity) return next(forbidden('API Key sin permisos de agente'));
        req.agent = identity;
        req.platform = identity.platform || null;
        return next();
      }

      const platform = await findPlatformByApiKey(apiKey);
      if (!platform) return next(forbidden('API Key no autorizada'));
      req.platform = platform;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Token de agente: "<payload base64url>.<firma hex>", payload = { sub, name, exp } (exp en segundos).
 * Lo firma el panel de tickets con AGENT_TOKEN_SECRET; sin secreto configurado no se aceptan tokens.
 */
function signAgentToken({ sub, name }, ttlSec = 12 * 60 * 60) {
  const secret = process.env.AGENT_TOKEN_SECRET || '';
  if (!secret) throw new Error('AGENT_TOKEN_SECRET no configurado');
  const payload = Buffer.from(
    JSON.stringify({ sub: String(sub), name: String(name || ''), exp: Math.floor(Date.now() / 1000) + ttlSec })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** Devuelve { sub, name } si el token es válido y no venció; si no, null. */
function verifyAgentToken(rawToken) {
  const secret = process.env.AGENT_TOKEN_SECRET || '';
  const token = asString(rawToken, { max: 2048 });
  if (!secret || !token) return null;

  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.sub || !Number.isFinite(data.exp) || data.exp * 1000 < Date.now()) return null;
    return { sub: String(data.sub), name: asString(data.name, { max: 120 }) || '' };
  } catch {
    return null;
  }
}

/** Middleware Socket.io para /agent: API Key de agente o token de agente firmado. */
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

    const tokenAgent = verifyAgentToken(auth.token);
    if (tokenAgent) {
      socket.agent = { kind: 'agent_token', sub: tokenAgent.sub };
      socket.agentName = tokenAgent.name || 'Agente';
      return next();
    }

    logger.warn('agent_socket_auth_rejected', {
      hasKey: !!apiKey,
      hasToken: !!auth.token,
      ip: socket.handshake.address
    });
    return next(new Error('Autenticación fallida: credencial de agente requerida'));
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
  signAgentToken,
  verifyAgentToken,
  signClientToken,
  verifyClientToken
};
