/**
 * Conversación = hilo de chat entre un ciudadano (Maracaibo) y soporte.
 * externalTicketId enlaza con el Sistema de Tickets (1 ticket activo ≈ 1 conversación).
 */

const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  platformId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Platform',
    required: [true, 'La plataforma es obligatoria']
  },
  customerName: {
    type: String,
    required: [true, 'El nombre del cliente es obligatorio'],
    trim: true
  },
  customerId: {
    type: String,
    required: [true, 'El ID del cliente es obligatorio'],
    index: true
  },
  /** ID del ticket en el sistema externo de tickets (ej. "TK-12345") */
  externalTicketId: {
    type: String,
    trim: true,
    index: true,
    sparse: true
  },
  /** Canal de origen del ciudadano */
  sourceChannel: {
    type: String,
    enum: ['maracaibo_app', 'maracaibo_web', 'ticket_system', 'unknown'],
    default: 'unknown'
  },
  /** Datos extra: trámite, cédula, versión de app, etc. */
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: {
      values: ['active', 'closed'],
      message: 'El estado debe ser "active" o "closed"'
    },
    default: 'active',
    index: true
  },
  lastMessage: {
    type: String,
    default: ''
  },
  isOnline: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

conversationSchema.index({ customerId: 1, platformId: 1, status: 1 });
conversationSchema.index({ externalTicketId: 1, status: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
