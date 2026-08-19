/**
 * ============================================
 * Rutas de API REST para Citas y Departamentos CPU
 * ============================================
 */

const express = require('express');
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
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Normalización de entrada: frontend CPUgestor → formato interno de chat-core-cpu
// El frontend envía { contributor, motivo, descripcion, scheduledAt }
// El backend espera  { taxpayer, subject, description, requestedDate, requestedTimeSlot }
// ---------------------------------------------------------------------------
function normalizeIncoming(body) {
  // Si ya viene en formato interno (taxpayer), no tocar
  if (body.taxpayer) return body;

  const { contributor = {}, motivo, descripcion, scheduledAt, ...rest } = body;
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
  router.get('/departments', async (req, res) => {
    try {
      const departments = await Department.find({ active: true }).sort({ name: 1 });
      return res.json({ success: true, count: departments.length, data: departments });
    } catch (err) {
      logger.error('api_departments_error', { error: err.message });
      return res.status(500).json({ success: false, error: 'Error al obtener departamentos' });
    }
  });

  // 2. Consulta de disponibilidad de horarios de un departamento para una fecha
  router.get('/departments/:id/availability', async (req, res) => {
    try {
      const { id } = req.params;
      const { date } = req.query; // YYYY-MM-DD
      if (!date) {
        return res.status(400).json({ success: false, error: 'Debe especificar el parámetro date (YYYY-MM-DD)' });
      }

      const availability = await getDepartmentAvailability(id, date);
      return res.json({ success: true, data: availability });
    } catch (err) {
      logger.error('api_availability_error', { error: err.message });
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 3. Crear nueva cita (acepta tanto formato frontend como interno)
  router.post('/appointments', async (req, res) => {
    try {
      const normalized = normalizeIncoming(req.body);
      const appointment = await createAppointment(normalized, ioAgentNamespace);
      return res.status(201).json({
        success: true,
        message: 'Cita agendada exitosamente',
        data: normalizeAppointmentForFrontend(appointment),
      });
    } catch (err) {
      logger.error('api_create_appointment_error', { error: err.message });
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 4. Consultar cita por código público (CPU-2026-8941)
  router.get('/appointments/track/:code', async (req, res) => {
    try {
      const appointment = await getAppointmentByCode(req.params.code);
      if (!appointment) {
        return res.status(404).json({ success: false, error: 'Cita no encontrada' });
      }
      return res.json({ success: true, data: normalizeAppointmentForFrontend(appointment) });
    } catch (err) {
      logger.error('api_track_appointment_error', { error: err.message });
      return res.status(500).json({ success: false, error: 'Error al consultar la cita' });
    }
  });

  // 5a. Citas por cédula/RIF — ruta interna
  router.get('/appointments/taxpayer/:cedulaRif', async (req, res) => {
    try {
      const appointments = await getAppointmentsByTaxpayer(req.params.cedulaRif);
      return res.json({
        success: true,
        count: appointments.length,
        data: appointments.map(normalizeAppointmentForFrontend),
      });
    } catch (err) {
      logger.error('api_taxpayer_appointments_error', { error: err.message });
      return res.status(500).json({ success: false, error: 'Error al obtener citas del contribuyente' });
    }
  });

  // 5b. Citas por cédula — ruta frontend CPUgestor: /api/appointments/contributor/:cedula
  router.get('/appointments/contributor/:cedula', async (req, res) => {
    try {
      const appointments = await getAppointmentsByTaxpayer(req.params.cedula);
      return res.json({
        success: true,
        count: appointments.length,
        data: appointments.map(normalizeAppointmentForFrontend),
      });
    } catch (err) {
      logger.error('api_contributor_appointments_error', { error: err.message });
      return res.status(500).json({ success: false, error: 'Error al obtener citas del contribuyente' });
    }
  });

  // 6. Bandeja del Jefe — citas de un departamento
  router.get('/appointments/department/:deptId', async (req, res) => {
    try {
      const { deptId } = req.params;
      const { status } = req.query;

      const deptDoc = await resolveDepartmentDoc(deptId);
      const filter = {};
      if (deptDoc) {
        filter.departmentId = deptDoc._id;
      } else if (require('mongoose').Types.ObjectId.isValid(deptId)) {
        filter.departmentId = deptId;
      } else {
        return res.json({ success: true, count: 0, data: [] });
      }

      if (status) filter.status = status;

      const appointments = await Appointment.find(filter)
        .populate('departmentId')
        .populate('conversationId')
        .sort({ createdAt: -1 });

      return res.json({
        success: true,
        count: appointments.length,
        data: appointments.map(normalizeAppointmentForFrontend),
      });
    } catch (err) {
      logger.error('api_dept_appointments_error', { error: err.message });
      return res.status(500).json({ success: false, error: 'Error al obtener la bandeja del departamento' });
    }
  });

  // 7. Mensajes del chat de una cita — usado por CitaChatModal
  router.get('/appointments/:id/messages', async (req, res) => {
    try {
      const appointment = await Appointment.findById(req.params.id);
      if (!appointment) {
        return res.status(404).json({ success: false, error: 'Cita no encontrada' });
      }
      if (!appointment.conversationId) {
        return res.json({ success: true, messages: [] });
      }
      const messages = await Message.find({ conversationId: appointment.conversationId })
        .sort({ createdAt: 1 })
        .lean();
      return res.json({ success: true, messages });
    } catch (err) {
      logger.error('api_appointment_messages_error', { error: err.message });
      return res.status(500).json({ success: false, error: 'Error al obtener mensajes de la cita' });
    }
  });

  // 8. Responder/Resolver cita (jefe da resolución)
  router.patch('/appointments/:id/respond', async (req, res) => {
    try {
      const updatedAppointment = await respondToAppointment(
        req.params.id,
        req.body,
        ioAgentNamespace,
        ioClientNamespace,
      );
      return res.json({
        success: true,
        message: 'Respuesta de cita procesada exitosamente',
        data: normalizeAppointmentForFrontend(updatedAppointment),
      });
    } catch (err) {
      logger.error('api_respond_appointment_error', { error: err.message });
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  expressApp.use('/api', router);
  logger.info('appointment_routes_registered');
}

module.exports = { registerAppointmentRoutes };
