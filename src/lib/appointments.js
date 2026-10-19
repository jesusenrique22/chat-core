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
const crypto = require('crypto');
const logger = require('./logger');
const { AGENTS_DASHBOARD_ROOM, getDepartmentRoom } = require('./socketRooms');
const { asString, asObjectId, clampInt, escapeRegex } = require('./validate');
const { badRequest, notFound, conflict } = require('./errors');

const DEFAULT_SLOTS = [
  '08:00 - 09:00',
  '09:00 - 10:00',
  '10:00 - 11:00',
  '11:00 - 12:00',
  '13:00 - 14:00',
  '14:00 - 15:00',
  '15:00 - 16:00'
];

const RESOLUTION_TYPES = ['RESUELTO_ONLINE', 'CONFIRMADA_PRESENCIAL', 'RECHAZADO', 'CANCELADA'];
const CODE_ATTEMPTS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Código único de cita (ej. CPU-2026-8941). Formato de 4 dígitos por compatibilidad;
 * tras varias colisiones se amplía a 6 dígitos para no bloquear cuando el año se llena.
 */
function generateAppointmentCode(digits = 4) {
  const year = new Date().getFullYear();
  const min = 10 ** (digits - 1);
  const randomDigits = crypto.randomInt(min, min * 10);
  return `CPU-${year}-${randomDigits}`;
}

/**
 * Ventana [inicio, fin) del día calendario en UTC — igual que se guardan las fechas "YYYY-MM-DD"
 * (independiente de la zona horaria del servidor).
 */
function getUtcDayWindow(dateInput) {
  const str = asString(dateInput, { max: 40 });
  if (!str || !/^\d{4}-\d{2}-\d{2}/.test(str)) {
    throw badRequest('Fecha inválida (use YYYY-MM-DD)');
  }
  const start = new Date(`${str.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw badRequest('Fecha inválida (use YYYY-MM-DD)');
  return { start, end: new Date(start.getTime() + DAY_MS) };
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

    // $setOnInsert: crea los que falten sin pisar cambios hechos en la BDD (capacidad, jefe, etc.)
    await Department.bulkWrite(
      defaultDepartments.map((dept) => ({
        updateOne: {
          filter: { code: dept.code },
          update: { $setOnInsert: dept },
          upsert: true
        }
      })),
      { ordered: false }
    );
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
  const conv = obj.conversationId;
  const conversationId = conv ? String(conv._id || conv) : null;

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
    conversationId,
  };
  // Eliminar _id duplicado para no confundir al frontend
  delete normalized._id;
  return normalized;
}

async function resolveDepartmentDoc(deptId) {
  const objectId = asObjectId(deptId);
  if (objectId) {
    const doc = await Department.findById(objectId);
    if (doc) return doc;
  }
  const str = asString(deptId, { max: 64 });
  if (!str) return null;
  const code = SLUG_TO_CODE[str.toLowerCase()] || str.toUpperCase();
  // Regex escapado: la entrada del usuario nunca se interpreta como patrón (ReDoS)
  return Department.findOne({
    $or: [{ code }, { name: new RegExp(escapeRegex(str), 'i') }]
  });
}

async function countActiveBookings(departmentObjectId, { start, end }, slot) {
  const filter = {
    departmentId: departmentObjectId,
    requestedDate: { $gte: start, $lt: end },
    status: { $ne: 'CANCELADA' }
  };
  if (slot) filter.requestedTimeSlot = slot;
  return Appointment.countDocuments(filter);
}

/**
 * Obtener disponibilidad de horarios para un departamento y fecha específica.
 */
async function getDepartmentAvailability(departmentId, dateStr) {
  const window = getUtcDayWindow(dateStr);
  const dept = await resolveDepartmentDoc(departmentId);
  if (!dept || !dept.active) {
    throw notFound('Departamento no encontrado o inactivo');
  }

  // Contar citas por horario con el _id real del departamento (antes se usaba el slug crudo
  // y nunca encontraba reservas → todo aparecía disponible).
  const usage = await Appointment.aggregate([
    {
      $match: {
        departmentId: dept._id,
        requestedDate: { $gte: window.start, $lt: window.end },
        status: { $ne: 'CANCELADA' }
      }
    },
    { $group: { _id: '$requestedTimeSlot', count: { $sum: 1 } } }
  ]);

  const slotsUsage = Object.fromEntries(usage.map((u) => [u._id, u.count]));

  const availability = DEFAULT_SLOTS.map(slot => {
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

  const clean = {
    name: asString(taxpayer?.name, { max: 200 }),
    cedulaRif: asString(taxpayer?.cedulaRif, { max: 40 }),
    email: asString(taxpayer?.email, { max: 200 }),
    phone: asString(taxpayer?.phone, { max: 40 }),
    subject: asString(subject, { max: 300 }),
    slot: asString(requestedTimeSlot, { max: 40 })
  };
  const missing = Object.entries({
    departmentId,
    'taxpayer.name': clean.name,
    'taxpayer.cedulaRif': clean.cedulaRif,
    'taxpayer.email': clean.email,
    'taxpayer.phone': clean.phone,
    subject: clean.subject,
    requestedDate,
    requestedTimeSlot: clean.slot
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw badRequest(`Todos los campos obligatorios deben ser proporcionados. Faltan: ${missing.join(', ')}`);
  }
  if (typeof description !== 'string' || description.length > 4000) {
    throw badRequest('description debe ser texto (máx 4000 caracteres)');
  }
  if (!Array.isArray(attachments) || attachments.length > 10) {
    throw badRequest('attachments debe ser una lista (máx 10)');
  }

  const requested = new Date(requestedDate);
  if (Number.isNaN(requested.getTime())) {
    throw badRequest('requestedDate inválida');
  }

  const dept = await resolveDepartmentDoc(departmentId);
  if (!dept || !dept.active) {
    throw badRequest('El departamento seleccionado no es válido o está inactivo.');
  }

  if (!DEFAULT_SLOTS.includes(clean.slot)) {
    logger.warn('appointment_unknown_slot', { slot: clean.slot, dept: dept.code });
  }

  // Control de capacidad: no se permite sobre-agendar un horario
  const booked = await countActiveBookings(dept._id, getUtcDayWindow(requested.toISOString()), clean.slot);
  if (booked >= dept.capacityPerHour) {
    throw conflict(`El horario ${clean.slot} ya no tiene cupos disponibles para ${dept.name}.`);
  }

  const validPlatformId = asObjectId(platformId);
  const baseDoc = {
    platformId: validPlatformId,
    departmentId: dept._id,
    taxpayer: {
      name: clean.name,
      cedulaRif: clean.cedulaRif,
      email: clean.email,
      phone: clean.phone
    },
    subject: clean.subject,
    description: description.trim(),
    attachments: attachments
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        url: asString(a.url, { max: 2048 }) || '',
        filename: asString(a.filename, { max: 255 }) || '',
        mimeType: asString(a.mimeType, { max: 100 }) || ''
      })),
    requestedDate: requested,
    requestedTimeSlot: clean.slot,
    status: 'PENDIENTE'
  };

  // Código único: se confía en el índice único (sin carrera check-then-insert) y se reintenta
  let appointment = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS && !appointment; attempt++) {
    const code = generateAppointmentCode(attempt < CODE_ATTEMPTS / 2 ? 4 : 6);
    try {
      appointment = await Appointment.create({ ...baseDoc, appointmentCode: code });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  if (!appointment) {
    throw new Error('No se pudo generar un código de cita único');
  }
  const code = appointment.appointmentCode;

  // Conversación de chat opcional para seguimiento en tiempo real (tras crear la cita:
  // si la cita falla no quedan conversaciones huérfanas)
  if (createChatConversation && validPlatformId) {
    try {
      const conversation = await Conversation.create({
        platformId: validPlatformId,
        customerName: clean.name,
        customerId: clean.cedulaRif,
        externalTicketId: code,
        sourceChannel: 'maracaibo_web',
        metadata: {
          departmentName: dept.name,
          subject: clean.subject,
          appointmentCode: code
        },
        lastMessage: `Cita solicitada: ${clean.subject} (${dept.name})`
      });
      appointment.conversationId = conversation._id;
      await appointment.save();
    } catch (err) {
      logger.error('appointment_conversation_failed', { code, error: err.message });
    }
  }

  const populatedAppointment = await Appointment.findById(appointment._id).populate('departmentId');

  // Emitir evento Socket.io en tiempo real al Jefe de Departamento y Dashboard de Agentes
  // IMPORTANTE: se usa el slug (ej. "direccion") y no el ObjectId para coincidir
  // con la sala a la que el frontend se unió via join_department.
  if (ioAgentNamespace) {
    const deptSlug = CODE_TO_SLUG[dept.code] || dept.code.toLowerCase();
    const deptRoom = getDepartmentRoom(deptSlug);
    const normalizedPayload = normalizeAppointmentForFrontend(populatedAppointment);
    ioAgentNamespace.to([AGENTS_DASHBOARD_ROOM, deptRoom]).emit('appointment_created', normalizedPayload);
  }

  logger.info('appointment_created', { code, dept: dept.name });

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

  if (!RESOLUTION_TYPES.includes(resolutionType)) {
    throw badRequest(`resolutionType inválido. Use: ${RESOLUTION_TYPES.join(', ')}`);
  }
  const id = asObjectId(appointmentId);
  if (!id) throw badRequest('ID de cita inválido');

  const app = await Appointment.findById(id).populate('departmentId');
  if (!app) {
    throw notFound('Cita no encontrada.');
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
    resolvedBy: asString(resolvedBy, { max: 200 }) || 'Jefe de Departamento',
    resolutionType,
    notes: typeof notes === 'string' ? notes.slice(0, 4000) : '',
    qrCodeUrl: asString(qrCodeUrl, { max: 2048 }) || (resolutionType === 'CONFIRMADA_PRESENCIAL' ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(app.appointmentCode)}` : ''),
    resolvedAt: new Date()
  };

  await app.save();

  // Si tiene conversación de chat asociada, registrar la resolución como mensaje del sistema/agente
  if (app.conversationId) {
    await Conversation.findByIdAndUpdate(app.conversationId, {
      lastMessage: `Respuesta de CPU (${resolutionType}): ${app.resolution.notes}`
    });
  }

  const deptDoc = app.departmentId; // populate ya ejecutado
  const deptSlug = CODE_TO_SLUG[deptDoc?.code] || (deptDoc?.code || '').toLowerCase();
  const normalizedPayload = normalizeAppointmentForFrontend(app);

  if (ioAgentNamespace) {
    ioAgentNamespace
      .to([AGENTS_DASHBOARD_ROOM, getDepartmentRoom(deptSlug)])
      .emit('appointment_updated', normalizedPayload);
  }

  // El ciudadano está en la sala = conversationId (sin prefijo "room_", que nunca coincidía)
  if (ioClientNamespace && app.conversationId) {
    ioClientNamespace.to(String(app.conversationId)).emit('appointment_updated', normalizedPayload);
  }

  logger.info('appointment_responded', { code: app.appointmentCode, resolutionType, status: newStatus });

  return app;
}

/**
 * Consultar cita por código público (ej. CPU-2026-8941) o Cédula/RIF.
 */
async function getAppointmentByCode(code) {
  const clean = asString(code, { max: 40 });
  if (!clean) return null;
  return Appointment.findOne({ appointmentCode: clean.toUpperCase() }).populate('departmentId').lean();
}

async function getAppointmentsByTaxpayer(cedulaRif, { limit } = {}) {
  const clean = asString(cedulaRif, { max: 40 });
  if (!clean) return [];
  return Appointment.find({ 'taxpayer.cedulaRif': clean })
    .populate('departmentId')
    .sort({ createdAt: -1 })
    .limit(clampInt(limit, { min: 1, max: 200, fallback: 100 }))
    .lean();
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
  DEFAULT_SLOTS,
};
