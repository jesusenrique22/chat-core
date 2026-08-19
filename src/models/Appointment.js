/**
 * ============================================
 * Modelo: Appointment (Cita / Tramite CPU)
 * ============================================
 * Registra cada solicitud de cita realizada desde Servicios Maracaibo hacia CPU.
 * Almacena datos del contribuyente, departamento destino, fecha/hora solicitada,
 * estado del trámite y la respuesta/resolución dada por el Jefe de Departamento.
 */

const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  appointmentCode: {
    type: String,
    required: [true, 'El código de la cita es obligatorio'],
    unique: true,
    index: true,
    trim: true
  },
  platformId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Platform',
    required: false
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: [true, 'El departamento es obligatorio'],
    index: true
  },
  taxpayer: {
    name: {
      type: String,
      required: [true, 'El nombre del contribuyente es obligatorio'],
      trim: true
    },
    cedulaRif: {
      type: String,
      required: [true, 'La Cédula o RIF es obligatoria'],
      trim: true,
      index: true
    },
    email: {
      type: String,
      required: [true, 'El correo electrónico es obligatorio'],
      trim: true,
      lowercase: true
    },
    phone: {
      type: String,
      required: [true, 'El teléfono de contacto es obligatorio'],
      trim: true
    }
  },
  subject: {
    type: String,
    required: [true, 'El motivo o asunto de la cita es obligatorio'],
    trim: true
  },
  description: {
    type: String,
    default: '',
    trim: true
  },
  attachments: [{
    url: String,
    filename: String,
    mimeType: String
  }],
  requestedDate: {
    type: Date,
    required: [true, 'La fecha solicitada es obligatoria'],
    index: true
  },
  requestedTimeSlot: {
    type: String,
    required: [true, 'El horario solicitado es obligatorio'],
    trim: true
  },
  status: {
    type: String,
    enum: {
      values: [
        'PENDIENTE',
        'EN_REVISION',
        'REQUERIMIENTO_CHAT',
        'RESUELTO_ONLINE',
        'CONFIRMADA_PRESENCIAL',
        'COMPLETADA',
        'CANCELADA'
      ],
      message: 'Estado de cita no válido'
    },
    default: 'PENDIENTE',
    index: true
  },
  resolution: {
    resolvedBy: {
      type: String,
      default: ''
    },
    resolutionType: {
      type: String,
      enum: ['RESUELTO_ONLINE', 'CONFIRMADA_PRESENCIAL', 'RECHAZADO', 'CANCELADA', 'PENDIENTE'],
      default: 'PENDIENTE'
    },
    notes: {
      type: String,
      default: ''
    },
    qrCodeUrl: {
      type: String,
      default: ''
    },
    resolvedAt: {
      type: Date
    }
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: false
  }
}, {
  timestamps: true
});

appointmentSchema.index({ 'taxpayer.cedulaRif': 1, status: 1 });
appointmentSchema.index({ departmentId: 1, requestedDate: 1 });
appointmentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Appointment', appointmentSchema);
