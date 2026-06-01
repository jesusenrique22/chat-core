/**
 * CORS compartido: Express, Socket.io y middleware de clientes.
 * Red local (Wi‑Fi/LAN) sin VPN — configurable vía .env
 */

const os = require('os');
const Platform = require('../models/Platform');

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
    return process.env.CORS_ALLOW_LAN !== 'false';
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
    const allPlatforms = await Platform.find().select('allowedOrigins');
    for (const platform of allPlatforms) {
      if (matchesAllowedList(origin, platform.allowedOrigins)) return true;
    }
  } catch (err) {
    console.error('Error validando CORS:', err);
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
  } catch (err) {
    console.error('Error sincronizando CORS:', err);
  }
}

function createCorsOriginHandler() {
  return async (origin, callback) => {
    try {
      const allowed = await isOriginAllowedGlobally(origin);
      if (allowed) return callback(null, true);
      console.warn(`⛔ CORS bloqueado: ${origin || '(sin origin)'}`);
      return callback(new Error(`CORS bloqueado para el origen: ${origin}`));
    } catch (err) {
      return callback(err);
    }
  };
}

function logShareUrls(port) {
  const ip = getLocalNetworkIp();
  console.log('');
  console.log('📡 Compartir en red local (sin VPN):');
  console.log(`   Backend + widget:  http://${ip}:${port}`);
  console.log(`   Demo Maracaibo:    http://${ip}:${port}/maracaibo.html`);
  console.log(`   Health API:        http://${ip}:${port}/api/integrations/health`);
  console.log(`   Dashboard agentes: http://${ip}:3000  (npm run dev)`);
  console.log('');
}

module.exports = {
  getExtraOrigins,
  getLocalNetworkIp,
  isDevOrigin,
  isOriginAllowedGlobally,
  isOriginAllowedForPlatform,
  syncMaracaiboOriginsOnStartup,
  createCorsOriginHandler,
  logShareUrls
};
