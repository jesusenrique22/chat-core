/**
 * Puerta única de la app ciudadana hacia sus tickets: crear, consultar y cambiar status.
 * Tickets sigue siendo el dueño de los datos; chat-core identifica al ciudadano, reenvía la
 * petición y entrega en tiempo real los cambios de status.
 */

const Conversation = require('../models/Conversation');
const { authenticateRequest, isMaracaiboPlatform, isTicketsPlatform } = require('./auth');
const { citizenAuthConfigured, resolveCitizen } = require('./citizenAuth');
const { linkConversation } = require('./integrations');
const { callTickets } = require('./ticketsClient');
const { getCitizenRoom } = require('./socketRooms');
const { asString } = require('./validate');
const { HttpError, badRequest, forbidden, unauthorized } = require('./errors');
const logger = require('./logger');

/** Campos que la app puede enviar al crear. La cédula sale del token y el responsable lo decide Tickets. */
const CREATE_FIELDS = [
  'kind', 'title', 'description', 'priority', 'problemType', 'category', 'institutionCode',
  'location', 'customer_email', 'citizen', 'anonymous', 'customerName'
];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** API Key de Maracaibo + sesión del ciudadano. Sin forma de validarla la puerta queda cerrada. */
async function requireCitizen(req) {
  if (!citizenAuthConfigured()) {
    throw new HttpError(503, 'Tickets para ciudadanos no configurado');
  }
  const platform = await authenticateRequest(req);
  if (!isMaracaiboPlatform(platform)) {
    throw forbidden('Solo Servicios Maracaibo puede usar esta ruta');
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const citizen = await resolveCitizen(token);
  if (!citizen) throw unauthorized('Token de ciudadano inválido o vencido');
  return citizen;
}

function ticketPath(req, suffix = '') {
  const ticketId = asString(req.params.ticketId, { max: 128 });
  if (!ticketId) throw badRequest('ticketId inválido');
  return `/${encodeURIComponent(ticketId)}${suffix}`;
}

/** Devuelve la respuesta de Tickets; un fallo interno suyo no se reenvía tal cual a la app. */
function relay(res, { status, data }) {
  if (status >= 500) {
    logger.error('tickets_api_error', { status, error: data?.error });
    throw new HttpError(502, 'El Sistema de Tickets no está disponible');
  }
  return res.status(status).json(data);
}

function registerTicketGatewayRoutes(expressApp, io) {
  expressApp.post('/api/integrations/tickets', async (req, res) => {
    const citizen = await requireCitizen(req);
    const customerName = citizen.name || asString(req.body?.customerName, { max: 200 }) || 'Ciudadano';

    const result = await callTickets('', {
      method: 'POST',
      body: { ...pick(req.body, CREATE_FIELDS), customerName, cedula: citizen.cedula }
    });
    if (result.status !== 201) return relay(res, result);

    // El chat queda listo. Si esto falla no se pierde el ticket: join_chat crea la conversación.
    let conversationId = null;
    try {
      const conversation = await linkConversation({
        ticketId: result.data.data._id,
        customerId: citizen.cedula,
        customerName,
        sourceChannel: 'maracaibo_app'
      });
      conversationId = conversation._id;
    } catch (err) {
      logger.error('ticket_conversation_link_failed', { ticketId: result.data.data._id, error: err.message });
    }
    return res.status(201).json({ ...result.data, conversationId });
  });

  expressApp.get('/api/integrations/tickets', async (req, res) => {
    const citizen = await requireCitizen(req);
    return relay(res, await callTickets('', { query: { cedula: citizen.cedula } }));
  });

  expressApp.get('/api/integrations/tickets/:ticketId', async (req, res) => {
    const citizen = await requireCitizen(req);
    return relay(res, await callTickets(ticketPath(req), { query: { cedula: citizen.cedula } }));
  });

  expressApp.patch('/api/integrations/tickets/:ticketId/status', async (req, res) => {
    const citizen = await requireCitizen(req);
    const { status, closeReasonCategory, closeReasonDetail } = req.body || {};
    return relay(res, await callTickets(ticketPath(req, '/status'), {
      method: 'PATCH',
      body: { cedula: citizen.cedula, status, closeReasonCategory, closeReasonDetail }
    }));
  });

  /** Tickets → ciudadano: aviso en vivo. El cierre del chat va aparte (/conversations/:id/close). */
  expressApp.post('/api/integrations/tickets/:ticketId/status-changed', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isTicketsPlatform(platform)) {
      throw forbidden('Solo la plataforma Sistema de Tickets puede usar esta ruta');
    }

    const ticketId = asString(req.params.ticketId, { max: 128 });
    const status = asString(req.body?.status, { max: 60 });
    if (!ticketId || !status) throw badRequest('ticketId y status son obligatorios');

    const conversation = await Conversation.findOne({ externalTicketId: ticketId })
      .select('_id customerId')
      .sort({ updatedAt: -1 })
      .lean();

    const rooms = [];
    if (conversation) rooms.push(String(conversation._id));
    const customerId = conversation?.customerId || asString(req.body?.customerId, { max: 128 });
    if (customerId) rooms.push(getCitizenRoom(customerId));

    // `status` es la etiqueta pública ("Caso en progreso"), la misma que devuelve la consulta REST.
    if (rooms.length) {
      io.of('/client').to(rooms).emit('ticket_status_changed', {
        ticketId,
        status,
        closed: req.body?.closed === true,
        changedAt: new Date().toISOString()
      });
    }
    res.json({ success: true, delivered: rooms.length > 0 });
  });
}

module.exports = { registerTicketGatewayRoutes };
