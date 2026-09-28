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
    required: [true, 'El ID del cliente es obligatorio']
  },
  /** ID del ticket en el sistema externo de tickets (ej. "TK-12345") */
  externalTicketId: {
    type: String,
    trim: true
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
    default: 'active'
  },
  lastMessage: {
    type: String,
    default: ''
  },
  lastCustomerMessageAt: {
    type: Date,
    default: null
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
// Máximo UNA conversación activa por ticket (evita duplicados por conexiones simultáneas).
// Si la BDD ya tiene duplicados, Mongo no crea el índice: se registra el error y el servicio sigue.
conversationSchema.index(
  { externalTicketId: 1 },
  {
    name: 'uniq_active_ticket',
    unique: true,
    partialFilterExpression: { status: 'active', externalTicketId: { $type: 'string', $gt: '' } }
  }
);
conversationSchema.index({ status: 1, updatedAt: -1 });
conversationSchema.index({ status: 1, lastCustomerMessageAt: 1 });
conversationSchema.index({ isOnline: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
