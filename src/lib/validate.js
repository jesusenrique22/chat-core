/**
 * Coerción defensiva de entradas externas (REST, Socket.io).
 * Evita inyección NoSQL: nunca pasar objetos del cliente directo a un filtro de Mongo.
 */

const mongoose = require('mongoose');

/** String recortado o null. Rechaza objetos/arrays (p. ej. { "$ne": null }). */
function asString(value, { max = 256 } = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function isObjectId(value) {
  return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && /^[a-f\d]{24}$/i.test(value);
}

/** ObjectId como string, o null si no es válido. */
function asObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  return isObjectId(value) ? value : null;
}

function clampInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Fecha válida o null. */
function asDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cédula/RIF comparable: mayúsculas, sin espacios, puntos ni guiones ("v-12.345.678" → "V12345678").
 * Misma regla que formatTicketCedula de la app de Servicios Maracaibo, más los puntos que
 * pueden traer los tickets cargados a mano en el panel.
 */
function normalizeCustomerId(value) {
  const str = asString(value, { max: 128 });
  return str ? str.toUpperCase().replace(/[\s.\-]/g, '') : '';
}

/** Ack de Socket.io seguro: siempre devuelve una función. */
function safeAck(callback) {
  return typeof callback === 'function' ? callback : () => {};
}

module.exports = {
  asString,
  asObjectId,
  isObjectId,
  clampInt,
  asDate,
  escapeRegex,
  normalizeCustomerId,
  safeAck
};
