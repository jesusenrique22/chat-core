/**
 * CORS compartido: Express, Socket.io y middleware de clientes.
 * Red local (Wi‑Fi/LAN) sin VPN — configurable vía .env
 */

const os = require('os');
const Platform = require('../models/Platform');
const logger = require('./logger');

const CORS_CACHE_TTL_MS = Number(process.env.CORS_CACHE_TTL_MS) || 5 * 60 * 1000;
let platformOriginsCache = null;
let platformOriginsCacheAt = 0;

async function getCachedPlatformOrigins() {
  const now = Date.now();
  if (platformOriginsCache && now - platformOriginsCacheAt < CORS_CACHE_TTL_MS) {
    return platformOriginsCache;
  }
  platformOriginsCache = await Platform.find().select('allowedOrigins').lean();
  platformOriginsCacheAt = now;
  return platformOriginsCache;
}

function invalidatePlatformOriginsCache() {
  platformOriginsCache = null;
  platformOriginsCacheAt = 0;
}

function getExtraOrigins() {
  return (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** IP IPv4 de esta máquina en la red local (para compartir con compañeros) */
function getLocalNetworkIp() {
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const net of ifaces) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function isPrivateLanIp(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isDevOrigin(origin) {
  if (!origin) return true;
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) return true;

  const match = origin.match(/^https?:\/\/([^/:]+)(:\d+)?/i);
  if (match && isPrivateLanIp(match[1])) {
    return process.env.CORS_ALLOW_LAN === 'true';
  }

  return false;
}

function matchesAllowedList(origin, allowedList) {
  if (!allowedList || !allowedList.length) return false;
  return allowedList.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed === origin) return true;
    return origin.startsWith(allowed);
  });
}

async function isOriginAllowedGlobally(origin) {
  if (!origin) return true;
  if (process.env.CORS_ALLOW_ALL === 'true') return true;
  if (isDevOrigin(origin)) return true;

  const extra = getExtraOrigins();
  if (matchesAllowedList(origin, extra)) return true;

  try {
    const allPlatforms = await getCachedPlatformOrigins();
    for (const platform of allPlatforms) {
      if (matchesAllowedList(origin, platform.allowedOrigins)) return true;
    }
  } catch (err) {
    logger.error('cors_validate_error', { error: err.message });
    return false;
  }

  return false;
}

function isOriginAllowedForPlatform(origin, platform) {
  if (!origin) return true;
  if (process.env.CORS_ALLOW_ALL === 'true') return true;
  if (isDevOrigin(origin)) return true;

  const extra = getExtraOrigins();
  if (matchesAllowedList(origin, extra)) return true;
  if (platform && matchesAllowedList(origin, platform.allowedOrigins)) return true;

  return false;
}

async function syncMaracaiboOriginsOnStartup() {
  const extra = getExtraOrigins();
  const lanIp = getLocalNetworkIp();
  const defaults = [
    '*',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    `http://${lanIp}:4000`,
    `http://${lanIp}:3000`,
    ...extra
  ];

  try {
    await Platform.updateOne(
      { name: 'Servicios Maracaibo' },
      { $addToSet: { allowedOrigins: { $each: defaults } } }
    );
    await Platform.updateOne(
      { name: 'Sistema de Tickets' },
      { $addToSet: { allowedOrigins: { $each: defaults } } }
    );
    invalidatePlatformOriginsCache();
  } catch (err) {
    logger.error('cors_sync_error', { error: err.message });
  }
}

function createCorsOriginHandler() {
  return async (origin, callback) => {
    try {
      const allowed = await isOriginAllowedGlobally(origin);
      if (allowed) return callback(null, true);
      logger.warn('cors_blocked', { origin: origin || '(sin origin)' });
      return callback(new Error(`CORS bloqueado para el origen: ${origin}`));
    } catch (err) {
      return callback(err);
    }
  };
}

function logShareUrls(port) {
  const ip = getLocalNetworkIp();
  logger.info('share_urls', {
    api: `http://${ip}:${port}`,
    health: `http://${ip}:${port}/api/integrations/health`,
    socketClient: `http://${ip}:${port}/client`,
    socketAgent: `http://${ip}:${port}/agent`
  });
}

module.exports = {
  getExtraOrigins,
  getLocalNetworkIp,
  isDevOrigin,
  isOriginAllowedGlobally,
  isOriginAllowedForPlatform,
  syncMaracaiboOriginsOnStartup,
  invalidatePlatformOriginsCache,
  createCorsOriginHandler,
  logShareUrls
};
