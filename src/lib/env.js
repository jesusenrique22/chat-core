/**
 * Carga y valida variables de entorno críticas.
 * Sin ellas el proceso no arranca (sin defaults silenciosos).
 */

const path = require('path');
const dotenv = require('dotenv');

const rootEnvPath = path.resolve(__dirname, '../../.env');
const localEnvPath = path.resolve(__dirname, '../../.env.local');

// Las pruebas fijan su propio entorno (Mongo en memoria): sin esto, .env.local (override)
// las apuntaría a la base real.
if (process.env.CHAT_CORE_SKIP_DOTENV !== 'true') {
  dotenv.config({ path: rootEnvPath });
  dotenv.config({ path: localEnvPath, override: true });
}

// Fallbacks solo para opcionales no secretas. NOTIFICATIONS_* y MONGODB_URI son obligatorias.
if (!process.env.BUCKET_FOLDER) {
  process.env.BUCKET_FOLDER = 'ticket_chat';
}
if (!process.env.BUCKET_UPLOAD_URL) {
  process.env.BUCKET_UPLOAD_URL = 'https://api-bucket.smart.com.ve/api/imau/upload';
}
if (!process.env.CORS_ALLOW_LAN) {
  process.env.CORS_ALLOW_LAN = 'false';
}
if (!process.env.CORS_ALLOW_ALL) {
  process.env.CORS_ALLOW_ALL = 'true';
}

const logger = require('./logger');

const REQUIRED_ENV = [
  'MONGODB_URI',
  'CORS_ALLOW_LAN',
  'CORS_ALLOW_ALL',
  'NOTIFICATIONS_API_URL',
  'NOTIFICATIONS_API_KEY',
  'BUCKET_UPLOAD_URL',
  'BUCKET_API_KEY'
];

const BOOLEAN_ENV = new Set(['CORS_ALLOW_LAN', 'CORS_ALLOW_ALL']);

function isPresent(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEnv() {
  const missing = [];
  const invalid = [];

  for (const key of REQUIRED_ENV) {
    const value = process.env[key];
    if (!isPresent(value)) {
      missing.push(key);
      continue;
    }
    if (BOOLEAN_ENV.has(key)) {
      const normalized = value.trim().toLowerCase();
      if (normalized !== 'true' && normalized !== 'false') {
        invalid.push(`${key} (debe ser "true" o "false", recibido: "${value}")`);
      } else {
        process.env[key] = normalized;
      }
    } else {
      process.env[key] = value.trim();
    }
  }

  if (missing.length || invalid.length) {
    logger.error('env_validation_failed', {
      missing,
      invalid,
      hint: 'Copia .env.example → .env o .env.local y completa las variables obligatorias'
    });
    process.exit(1);
  }
}

validateEnv();

// Avisos de configuración insegura (no bloquean el arranque)
if (process.env.NODE_ENV === 'production') {
  if (process.env.CORS_ALLOW_ALL === 'true') {
    logger.warn('insecure_config', {
      setting: 'CORS_ALLOW_ALL=true',
      hint: 'En producción usa CORS_ALLOW_ALL=false y lista los orígenes en CORS_EXTRA_ORIGINS'
    });
  }
  if (!process.env.AGENT_TOKEN_SECRET) {
    logger.warn('insecure_config', {
      setting: 'AGENT_TOKEN_SECRET vacío',
      hint: 'El panel de tickets no podrá conectar el socket /agent desde el navegador'
    });
  }
}

module.exports = {
  REQUIRED_ENV,
  validateEnv,
  MONGODB_URI: process.env.MONGODB_URI,
  CORS_ALLOW_LAN: process.env.CORS_ALLOW_LAN === 'true',
  CORS_ALLOW_ALL: process.env.CORS_ALLOW_ALL === 'true',
  BUCKET_UPLOAD_URL: process.env.BUCKET_UPLOAD_URL,
  BUCKET_API_KEY: process.env.BUCKET_API_KEY,
  BUCKET_FOLDER: process.env.BUCKET_FOLDER,
  NOTIFICATIONS_API_URL: process.env.NOTIFICATIONS_API_URL,
  NOTIFICATIONS_API_KEY: process.env.NOTIFICATIONS_API_KEY,
  REDIS_URL: process.env.REDIS_URL || ''
};
