/**
 * Cliente servidor a servidor hacia el Sistema de Tickets, que sigue siendo el dueño de los tickets:
 * chat-core no guarda copia de ellos ni de su status.
 *
 * Usa la misma credencial que el webhook (NOTIFICATIONS_API_KEY) y, si no se define
 * TICKETS_API_URL, el mismo servidor que NOTIFICATIONS_API_URL.
 */

const { HttpError } = require('./errors');
const logger = require('./logger');

const TIMEOUT_MS = Number(process.env.TICKETS_API_TIMEOUT_MS) || 10_000;
const GATEWAY_PATH = '/integrations/chat-core/tickets';

function ticketsBaseUrl() {
  const explicit = (process.env.TICKETS_API_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return new URL(process.env.NOTIFICATIONS_API_URL).origin;
}

/**
 * Devuelve { status, data } tal como responde Tickets. Sin respuesta lanza 502/504.
 * Las lecturas se reintentan una vez; las escrituras no, porque podrían duplicar un ticket.
 */
async function callTickets(path = '', { method = 'GET', body, query } = {}) {
  const url = new URL(`${ticketsBaseUrl()}${GATEWAY_PATH}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const attempts = method === 'GET' ? 2 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.NOTIFICATIONS_API_KEY },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    } catch (err) {
      if (attempt < attempts) continue;
      const timedOut = err.name === 'TimeoutError';
      logger.error('tickets_api_unreachable', { method, path, error: err.message });
      throw new HttpError(timedOut ? 504 : 502, 'El Sistema de Tickets no está disponible');
    }
  }
}

/**
 * ¿El ticket está CERRADO (estado definitivo)? Se consulta solo al ir a reabrir una conversación.
 * Un ticket que Tickets no conoce no está cerrado. Sin respuesta se asume cerrado: mejor un chat
 * que sigue cerrado un momento que reabrir uno definitivo.
 */
async function isTicketLocked(ticketId) {
  try {
    const { status, data } = await callTickets(`/${encodeURIComponent(ticketId)}/status`);
    if (status === 404) return false;
    if (status >= 200 && status < 300) return data?.data?.status === 'CERRADO';
    logger.error('ticket_lock_check_failed', { ticketId, status });
    return true;
  } catch {
    return true;
  }
}

module.exports = { callTickets, isTicketLocked };
