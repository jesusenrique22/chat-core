/**
 * Carga y valida variables de entorno críticas.
 * Sin ellas el proceso no arranca (sin defaults silenciosos).
 */

require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const logger = require('./logger');

const REQUIRED_ENV = [
  'MONGODB_URI',
  'CORS_ALLOW_LAN',
  'CORS_ALLOW_ALL',
  'BUCKET_UPLOAD_URL',
  'BUCKET_API_KEY',
  'BUCKET_FOLDER',
  'NOTIFICATIONS_API_URL',
  'NOTIFICATIONS_API_KEY'
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
  NOTIFICATIONS_API_KEY: process.env.NOTIFICATIONS_API_KEY
};
