/**
 * ============================================
 * Módulo: Lógica de Negocio de Citas CPU (appointments.js)
 * ============================================
 * Maneja la creación, disponibilidad, consulta y resolución de citas
 * entre Servicios Maracaibo y los Jefes de Departamento de CPU.
 */

const Department = require('../models/Department');
const Appointment = require('../models/Appointment');
const Conversation = require('../models/Conversation');
const logger = require('./logger');
const { AGENTS_DASHBOARD_ROOM, getDepartmentRoom } = require('./socketRooms');

// Generador de código único de cita (ej. CPU-2026-8941)
function generateAppointmentCode() {
  const year = new Date().getFullYear();
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `CPU-${year}-${randomDigits}`;
}

/**
 * Inicializa los departamentos por defecto de CPU si la colección está vacía.
 */
async function seedDepartmentsIfEmpty() {
  try {
    const defaultDepartments = [
      {
        name: 'Nomenclatura y Codificación',
        code: 'NOM',
        description: 'Asignación de nomenclatura urbana y códigos de inmueble.',
        headName: 'Edeana Chacón / Karina',
        capacityPerHour: 6
      },
      {
        name: 'Ubicaciones',
        code: 'UBI',
        description: 'Certificación de ubicación geográfica y espacial del inmueble.',
        headName: 'Elenmeri Vargas',
        capacityPerHour: 6
      },
      {
        name: 'Valuación',
        code: 'VAL',
        description: 'Cálculo del valor fiscal de inmuebles para el cobro de inmuebles urbanos y avalúos.',
        headName: 'Edwin',
        capacityPerHour: 5
      },
      {
        name: 'Dirección General',
        code: 'DIR',
        description: 'Atención por la Dirección General de CPU.',
        headName: 'Wilmer (Director)',
        capacityPerHour: 4
      },
      {
        name: 'Consultoría Legal',
        code: 'LEG',
        description: 'Dictámenes legales, expedientes jurídicos y recursos administrativos.',
        headName: 'Dra. Andreina Urdaneta / Dra. María Miyan',
        capacityPerHour: 5
      },
      {
        name: 'Mapa Digital',
        code: 'MAP',
        description: 'Cartografía digital, sistemas SIG y capas geográficas.',
        headName: 'Geraldo Solano',
        capacityPerHour: 6
      }
    ];

    for (const dept of defaultDepartments) {
      await Department.findOneAndUpdate(
        { code: dept.code },
        { $set: dept },
        { upsert: true, returnDocument: 'after' }
      );
    }
    logger.info('auto_seed_departments_done');
  } catch (err) {
    logger.error('auto_seed_departments_failed', { error: err.message });
  }
}

const SLUG_TO_CODE = {
  direccion: 'DIR',
  valuacion: 'VAL',
  nomenclatura: 'NOM',
  ubicaciones: 'UBI',
  legal: 'LEG',
  mapa_digital: 'MAP',
  atencion: 'ATC',
  catastro: 'CAT',
  control_urbano: 'CURB',
  deberes: 'DEF',
  permisologia: 'PERM',
};

// Mapa inverso: código → slug (para salas de Socket.io y respuestas al frontend)
const CODE_TO_SLUG = Object.fromEntries(
  Object.entries(SLUG_TO_CODE).map(([slug, code]) => [code, slug])
);

/**
 * Normaliza un documento Appointment de MongoDB al formato que espera el frontend CPUgestor.
 * Convierte: taxpayer→contributor, subject→motivo, requestedDate→scheduledAt,
 *            resolution.* → campos planos, departmentId ObjectId → slug, _id → id.
 */
function normalizeAppointmentForFrontend(app) {
  const obj = (app && typeof app.toObject === 'function') ? app.toObject() : { ...app };

  const dept = obj.departmentId;
  const deptCode = (dept && typeof dept === 'object' && dept.code) ? dept.code : '';
  const deptSlug = CODE_TO_SLUG[deptCode] || deptCode.toLowerCase() || (dept ? String(dept) : '');

  const fullName = obj.taxpayer?.name || '';
  const parts = fullName.trim().split(/\s+/);
  const nombre = parts[0] || '';
  const apellido = parts.slice(1).join(' ') || '';

  const normalized = {
    ...obj,
    id: obj._id ? obj._id.toString() : (obj.id || ''),
    departmentId: deptSlug,
    // Campos en formato frontend
    motivo: obj.subject || '',
    descripcion: obj.description || '',
    scheduledAt: obj.requestedDate || null,
    contributor: {
      nombre,
      apellido,
      cedula: obj.taxpayer?.cedulaRif || '',
      email: obj.taxpayer?.email || '',
      telefono: obj.taxpayer?.phone || '',
    },
    // Resolución aplanada
    notes: obj.resolution?.notes || '',
    qrCodeUrl: obj.resolution?.qrCodeUrl || '',
    resolvedBy: obj.resolution?.resolvedBy || '',
    resolutionType: obj.resolution?.resolutionType || '',
    // conversationId como string
    conversationId: obj.conversationId ? obj.conversationId.toString() : null,
  };
  // Eliminar _id duplicado para no confundir al frontend
  delete normalized._id;
  return normalized;
}

async function resolveDepartmentDoc(deptId) {
  if (!deptId) return null;
  const mongoose = require('mongoose');
  if (mongoose.Types.ObjectId.isValid(deptId)) {
    const doc = await Department.findById(deptId);
    if (doc) return doc;
  }
  const str = String(deptId).trim();
  const code = SLUG_TO_CODE[str.toLowerCase()] || str.toUpperCase();
  const doc = await Department.findOne({
    $or: [{ code: code }, { name: new RegExp(str, 'i') }]
  });
  return doc;
}

/**
 * Obtener disponibilidad de horarios para un departamento y fecha específica.
 */
async function getDepartmentAvailability(departmentId, dateStr) {
  const dept = await resolveDepartmentDoc(departmentId);
  if (!dept || !dept.active) {
    throw new Error('Departamento no encontrado o inactivo');
  }

  const targetDate = new Date(dateStr);
  const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
  const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

  // Bloques de horario predeterminados
  const defaultSlots = [
    '08:00 - 09:00',
    '09:00 - 10:00',
    '10:00 - 11:00',
    '11:00 - 12:00',
    '13:00 - 14:00',
    '14:00 - 15:00',
    '15:00 - 16:00'
  ];

  // Contar citas ya agendadas por horario en esa fecha
  const existingAppointments = await Appointment.find({
    departmentId,
    requestedDate: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ['CANCELADA'] }
  });

  const slotsUsage = {};
  existingAppointments.forEach(app => {
    slotsUsage[app.requestedTimeSlot] = (slotsUsage[app.requestedTimeSlot] || 0) + 1;
  });

  const availability = defaultSlots.map(slot => {
    const booked = slotsUsage[slot] || 0;
    const available = Math.max(0, dept.capacityPerHour - booked);
    return {
      slot,
      booked,
      capacity: dept.capacityPerHour,
      available: available > 0
    };
  });

  return {
    department: {
      id: dept._id,
      name: dept.name,
      code: dept.code,
      headName: dept.headName
    },
    date: dateStr,
    slots: availability
  };
}

/**
 * Crear una nueva cita desde Servicios Maracaibo hacia CPU.
 */
async function createAppointment(data, ioAgentNamespace = null) {
  const {
    departmentId,
    taxpayer,
    subject,
    description = '',
    attachments = [],
    requestedDate,
    requestedTimeSlot,
    platformId = null,
    createChatConversation = true
  } = data;

  if (!departmentId || !taxpayer || !taxpayer.name || !taxpayer.cedulaRif || !taxpayer.email || !taxpayer.phone || !subject || !requestedDate || !requestedTimeSlot) {
    throw new Error('Todos los campos obligatorios deben ser proporcionados.');
  }

  const dept = await resolveDepartmentDoc(departmentId);
  if (!dept || !dept.active) {
    throw new Error('El departamento seleccionado no es válido o está inactivo.');
  }

  // Generar código único de cita
  let code = generateAppointmentCode();
  let exists = await Appointment.findOne({ appointmentCode: code });
  while (exists) {
    code = generateAppointmentCode();
    exists = await Appointment.findOne({ appointmentCode: code });
  }

  // Crear conversación de chat opcional para el seguimiento en tiempo real
  let conversation = null;
  if (createChatConversation && platformId) {
    conversation = await Conversation.create({
      platformId,
      customerName: taxpayer.name,
      customerId: taxpayer.cedulaRif,
      externalTicketId: code,
      sourceChannel: 'maracaibo_web',
      metadata: {
        departmentName: dept.name,
        subject,
        appointmentCode: code
      },
      lastMessage: `Cita solicitada: ${subject} (${dept.name})`
    });
  }

  const appointment = await Appointment.create({
    appointmentCode: code,
    platformId,
    departmentId: dept._id,
    taxpayer: {
      name: taxpayer.name.trim(),
      cedulaRif: taxpayer.cedulaRif.trim(),
      email: taxpayer.email.trim(),
      phone: taxpayer.phone.trim()
    },
    subject: subject.trim(),
    description: description.trim(),
    attachments,
    requestedDate: new Date(requestedDate),
    requestedTimeSlot,
    status: 'PENDIENTE',
    conversationId: conversation ? conversation._id : null
  });

  const populatedAppointment = await Appointment.findById(appointment._id).populate('departmentId');

  // Emitir evento Socket.io en tiempo real al Jefe de Departamento y Dashboard de Agentes
  // IMPORTANTE: se usa el slug (ej. "direccion") y no el ObjectId para coincidir
  // con la sala a la que el frontend se unió via join_department.
  if (ioAgentNamespace) {
    const deptSlug = CODE_TO_SLUG[dept.code] || dept.code.toLowerCase();
    const deptRoom = getDepartmentRoom(deptSlug);
    const normalizedPayload = normalizeAppointmentForFrontend(populatedAppointment);
    ioAgentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('appointment_created', normalizedPayload);
    ioAgentNamespace.to(deptRoom).emit('appointment_created', normalizedPayload);
  }

  logger.info('appointment_created', { code, dept: dept.name, taxpayer: taxpayer.cedulaRif });

  return populatedAppointment;
}

/**
 * Responder/Resolver una cita por el Jefe de Departamento.
 */
async function respondToAppointment(appointmentId, responseData, ioAgentNamespace = null, ioClientNamespace = null) {
  const {
    resolvedBy = 'Jefe de Departamento',
    resolutionType, // 'RESUELTO_ONLINE' | 'CONFIRMADA_PRESENCIAL' | 'RECHAZADO' | 'CANCELADA'
    notes = '',
    qrCodeUrl = ''
  } = responseData;

  const app = await Appointment.findById(appointmentId).populate('departmentId');
  if (!app) {
    throw new Error('Cita no encontrada.');
  }

  let newStatus = app.status;
  if (resolutionType === 'RESUELTO_ONLINE') {
    newStatus = 'RESUELTO_ONLINE';
  } else if (resolutionType === 'CONFIRMADA_PRESENCIAL') {
    newStatus = 'CONFIRMADA_PRESENCIAL';
  } else if (resolutionType === 'RECHAZADO' || resolutionType === 'CANCELADA') {
    newStatus = 'CANCELADA';
  }

  app.status = newStatus;
  app.resolution = {
    resolvedBy,
    resolutionType,
    notes,
    qrCodeUrl: qrCodeUrl || (resolutionType === 'CONFIRMADA_PRESENCIAL' ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(app.appointmentCode)}` : ''),
    resolvedAt: new Date()
  };

  await app.save();

  // Si tiene conversación de chat asociada, registrar la resolución como mensaje del sistema/agente
  if (app.conversationId) {
    await Conversation.findByIdAndUpdate(app.conversationId, {
      lastMessage: `Respuesta de CPU (${resolutionType}): ${notes}`
    });
  }

  const deptDoc = app.departmentId; // populate ya ejecutado
  const deptSlug = CODE_TO_SLUG[deptDoc?.code] || (deptDoc?.code || '').toLowerCase();
  const normalizedPayload = normalizeAppointmentForFrontend(app);

  if (ioAgentNamespace) {
    ioAgentNamespace.to(AGENTS_DASHBOARD_ROOM).emit('appointment_updated', normalizedPayload);
    ioAgentNamespace.to(getDepartmentRoom(deptSlug)).emit('appointment_updated', normalizedPayload);
  }

  if (ioClientNamespace && app.conversationId) {
    ioClientNamespace.to(`room_${app.conversationId}`).emit('appointment_updated', normalizedPayload);
  }

  logger.info('appointment_responded', { code: app.appointmentCode, resolutionType, status: newStatus });

  return app;
}

/**
 * Consultar cita por código público (ej. CPU-2026-8941) o Cédula/RIF.
 */
async function getAppointmentByCode(code) {
  return await Appointment.findOne({ appointmentCode: code.toUpperCase() }).populate('departmentId');
}

async function getAppointmentsByTaxpayer(cedulaRif) {
  return await Appointment.find({ 'taxpayer.cedulaRif': cedulaRif }).populate('departmentId').sort({ createdAt: -1 });
}

module.exports = {
  seedDepartmentsIfEmpty,
  generateAppointmentCode,
  getDepartmentAvailability,
  createAppointment,
  respondToAppointment,
  getAppointmentByCode,
  getAppointmentsByTaxpayer,
  resolveDepartmentDoc,
  normalizeAppointmentForFrontend,
  CODE_TO_SLUG,
};
