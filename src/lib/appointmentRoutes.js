/**
 * ============================================
 * Rutas de API REST para Citas y Departamentos CPU
 * ============================================
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const Department = require('../models/Department');
const Appointment = require('../models/Appointment');
const Message = require('../models/Message');
const {
  getDepartmentAvailability,
  createAppointment,
  respondToAppointment,
  getAppointmentByCode,
  getAppointmentsByTaxpayer,
  resolveDepartmentDoc,
  normalizeAppointmentForFrontend,
} = require('./appointments');
const { requireAuth } = require('./auth');
const { asObjectId, clampInt } = require('./validate');
const { badRequest, notFound } = require('./errors');
const logger = require('./logger');

const limiterOptions = { windowMs: 60 * 1000, standardHeaders: true, legacyHeaders: false };
const createLimiter = rateLimit({
  ...limiterOptions,
  max: Number(process.env.RATE_LIMIT_APPOINTMENTS_CREATE) || 10,
  message: { success: false, error: 'Demasiadas solicitudes de cita. Intente de nuevo en un minuto.' }
});
const lookupLimiter = rateLimit({
  ...limiterOptions,
  max: Number(process.env.RATE_LIMIT_APPOINTMENTS_LOOKUP) || 60,
  message: { success: false, error: 'Demasiadas consultas. Intente de nuevo en un minuto.' }
});

const platformAuth = requireAuth('platform');
const agentAuth = requireAuth('agent');

// ---------------------------------------------------------------------------
// Normalización de entrada: frontend CPUgestor → formato interno de chat-core-cpu
// El frontend envía { contributor, motivo, descripcion, scheduledAt }
// El backend espera  { taxpayer, subject, description, requestedDate, requestedTimeSlot }
// ---------------------------------------------------------------------------
function normalizeIncoming(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Cuerpo de la solicitud inválido');
  }
  // Si ya viene en formato interno (taxpayer), no tocar
  if (body.taxpayer) return body;

  const { motivo, descripcion, scheduledAt, ...rest } = body;
  const contributor = body.contributor && typeof body.contributor === 'object' ? body.contributor : {};
  const name = `${contributor.nombre || ''} ${contributor.apellido || ''}`.trim() || 'Sin nombre';
  const cedulaRif = contributor.cedula || contributor.rif || contributor.customerId || 'SIN-ID';

  return {
    ...rest,
    taxpayer: {
      name,
      cedulaRif,
      email: contributor.email || '',
      phone: contributor.telefono || contributor.phone || '',
    },
    subject: motivo || body.subject || 'Sin motivo',
    description: descripcion || body.description || '',
    requestedDate: scheduledAt || body.requestedDate || new Date().toISOString(),
    requestedTimeSlot: body.requestedTimeSlot || '08:00 - 09:00',
  };
}

function registerAppointmentRoutes(expressApp, ioAgentNamespace, ioClientNamespace) {
  const router = express.Router();

  // 1. Lista de departamentos CPU activos
  router.get('/departments', platformAuth, async (req, res) => {
    const departments = await Department.find({ active: true }).sort({ name: 1 }).lean();
    return res.json({ success: true, count: departments.length, data: departments });
  });

  // 2. Consulta de disponibilidad de horarios de un departamento para una fecha
  router.get('/departments/:id/availability', lookupLimiter, platformAuth, async (req, res) => {
    const { date } = req.query; // YYYY-MM-DD
    if (!date) {
      return res.status(400).json({ success: false, error: 'Debe especificar el parámetro date (YYYY-MM-DD)' });
    }

    const availability = await getDepartmentAvailability(req.params.id, date);
    return res.json({ success: true, data: availability });
  });

  // 3. Crear nueva cita (acepta tanto formato frontend como interno)
  router.post('/appointments', createLimiter, platformAuth, async (req, res) => {
    const normalized = normalizeIncoming(req.body);
    // Si la petición viene autenticada, la cita pertenece a esa plataforma
    if (req.platform && !normalized.platformId) {
      normalized.platformId = String(req.platform._id);
    }
    const appointment = await createAppointment(normalized, ioAgentNamespace);
    return res.status(201).json({
      success: true,
      message: 'Cita agendada exitosamente',
      data: normalizeAppointmentForFrontend(appointment),
    });
  });

  // 4. Consultar cita por código público (CPU-2026-8941)
  router.get('/appointments/track/:code', lookupLimiter, platformAuth, async (req, res) => {
    const appointment = await getAppointmentByCode(req.params.code);
    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Cita no encontrada' });
    }
    return res.json({ success: true, data: normalizeAppointmentForFrontend(appointment) });
  });

  // 5a/5b. Citas por cédula/RIF — ruta interna y ruta frontend CPUgestor
  const listByTaxpayer = async (req, res) => {
    const appointments = await getAppointmentsByTaxpayer(req.params.cedula, { limit: req.query.limit });
    return res.json({
      success: true,
      count: appointments.length,
      data: appointments.map(normalizeAppointmentForFrontend),
    });
  };
  router.get('/appointments/taxpayer/:cedula', lookupLimiter, platformAuth, listByTaxpayer);
  router.get('/appointments/contributor/:cedula', lookupLimiter, platformAuth, listByTaxpayer);

  // 6. Bandeja del Jefe — citas de un departamento
  router.get('/appointments/department/:deptId', agentAuth, async (req, res) => {
    const { deptId } = req.params;
    const { status } = req.query;

    const deptDoc = await resolveDepartmentDoc(deptId);
    const filter = {};
    if (deptDoc) {
      filter.departmentId = deptDoc._id;
    } else if (asObjectId(deptId)) {
      filter.departmentId = deptId;
    } else {
      return res.json({ success: true, count: 0, data: [] });
    }

    if (typeof status === 'string' && status) filter.status = status;

    const appointments = await Appointment.find(filter)
      .populate('departmentId')
      .sort({ createdAt: -1 })
      .limit(clampInt(req.query.limit, { min: 1, max: 1000, fallback: 500 }))
      .lean();

    return res.json({
      success: true,
      count: appointments.length,
      data: appointments.map(normalizeAppointmentForFrontend),
    });
  });

  // 7. Mensajes del chat de una cita — usado por CitaChatModal
  router.get('/appointments/:id/messages', agentAuth, async (req, res) => {
    const id = asObjectId(req.params.id);
    if (!id) throw badRequest('ID de cita inválido');

    const appointment = await Appointment.findById(id).select('conversationId').lean();
    if (!appointment) throw notFound('Cita no encontrada');
    if (!appointment.conversationId) {
      return res.json({ success: true, messages: [] });
    }
    // Message no tiene createdAt: el orden cronológico es por timestamp
    const messages = await Message.find({ conversationId: appointment.conversationId })
      .sort({ timestamp: 1 })
      .limit(clampInt(req.query.limit, { min: 1, max: 2000, fallback: 500 }))
      .lean();
    return res.json({ success: true, messages });
  });

  // 8. Responder/Resolver cita (jefe da resolución)
  router.patch('/appointments/:id/respond', agentAuth, async (req, res) => {
    const updatedAppointment = await respondToAppointment(
      req.params.id,
      req.body || {},
      ioAgentNamespace,
      ioClientNamespace,
    );
    return res.json({
      success: true,
      message: 'Respuesta de cita procesada exitosamente',
      data: normalizeAppointmentForFrontend(updatedAppointment),
    });
  });

  expressApp.use('/api', router);
  logger.info('appointment_routes_registered');
}

module.exports = { registerAppointmentRoutes };
