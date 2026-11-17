/**
 * Identidad del ciudadano en las rutas de la app.
 *
 * El accessToken de Servicios Maracaibo (PASETO v*.local) está cifrado con una clave suya: chat-core
 * no puede leerlo, así que le pregunta a su API de quién es (SM_AUTH_ME_URL). La cédula nunca se toma
 * de lo que envía la app. El resultado se guarda unos minutos para no consultar en cada petición:
 * una sesión revocada sigue sirviendo aquí hasta que venza esa caché.
 */

const crypto = require('crypto');
const { verifyCitizenToken } = require('./auth');
const { HttpError } = require('./errors');
const { asString } = require('./validate');
const logger = require('./logger');

const SESSION_TOKEN = /^v\d+\.local\./;
const MAX_TOKEN_LENGTH = 4096;
const TIMEOUT_MS = Number(process.env.SM_AUTH_TIMEOUT_MS) || 5000;
const VALID_TTL_MS = Number(process.env.SM_AUTH_CACHE_MS) || 5 * 60 * 1000;
const INVALID_TTL_MS = 10 * 1000;
const MAX_CACHE_ENTRIES = 5000;

const cache = new Map(); // sha256(token) → { citizen|null, expiresAt }

function meUrl() {
  return (process.env.SM_AUTH_ME_URL || '').trim();
}

function citizenAuthConfigured() {
  return Boolean(meUrl() || process.env.CITIZEN_TOKEN_SECRET);
}

function isSessionToken(token) {
  return typeof token === 'string' && SESSION_TOKEN.test(token);
}

function remember(key, citizen) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, { citizen, expiresAt: Date.now() + (citizen ? VALID_TTL_MS : INVALID_TTL_MS) });
  return citizen;
}

/** Devuelve { cedula, name } o null. Si la API de SM no responde lanza 503: sin certeza no se entra. */
async function resolveSessionToken(token) {
  const url = meUrl();
  if (!url) return null;

  const key = crypto.createHash('sha256').update(token).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.citizen;

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    logger.error('sm_auth_unreachable', { error: err.message });
    throw new HttpError(503, 'No se pudo validar la sesión');
  }

  if (res.status === 401 || res.status === 403) return remember(key, null);
  if (!res.ok) {
    logger.error('sm_auth_error', { status: res.status });
    throw new HttpError(503, 'No se pudo validar la sesión');
  }

  const user = await res.json().catch(() => null);
  const cedula = asString(user?.dni, { max: 128 });
  if (!cedula) {
    logger.warn('sm_auth_without_dni');
    return remember(key, null);
  }
  return remember(key, { cedula, name: asString(user?.name, { max: 200 }) || '' });
}

/** Acepta la sesión de SM o, si hay CITIZEN_TOKEN_SECRET, un token firmado. */
async function resolveCitizen(rawToken) {
  const token = asString(rawToken, { max: MAX_TOKEN_LENGTH });
  if (!token) return null;
  return isSessionToken(token) ? resolveSessionToken(token) : verifyCitizenToken(token);
}

module.exports = { citizenAuthConfigured, isSessionToken, resolveCitizen };
