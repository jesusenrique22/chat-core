/**
 * Modelo: Message — texto (emojis UTF-8) o imagen (URL pública en attachment, archivo en bucket).
 */

const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, default: 0 },
    fileName: { type: String, default: '' }
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: [true, 'La conversación asociada es obligatoria']
  },
  senderType: {
    type: String,
    enum: {
      values: ['customer', 'agent'],
      message: 'El remitente debe ser "customer" o "agent"'
    },
    required: [true, 'El tipo de remitente es obligatorio']
  },
  messageType: {
    type: String,
    enum: ['text', 'image'],
    default: 'text'
  },
  content: {
    type: String,
    default: '',
    trim: true,
    maxlength: 4000
  },
  attachment: {
    type: attachmentSchema,
    default: null
  },
  senderName: {
    type: String,
    trim: true,
    default: ''
  },
  /** Canal por el que entró/salió el mensaje (trazabilidad) */
  deliveryChannel: {
    type: String,
    enum: [
      'socket_client',
      'socket_agent',
      'rest_tickets',
      'rest_maracaibo',
      'unknown'
    ],
    default: 'unknown'
  },
  /** inbound = ciudadano → soporte | outbound = agente → ciudadano */
  direction: {
    type: String,
    enum: ['inbound', 'outbound']
  },
  /** Denormalizado para consultas de historial por ticket sin join */
  externalTicketId: {
    type: String,
    trim: true,
    default: ''
  },
  customerId: {
    type: String,
    trim: true,
    default: ''
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  /** Cuándo el ciudadano (Servicios Maracaibo) vio el mensaje del agente */
  readByCustomerAt: {
    type: Date,
    default: null
  }
});

messageSchema.index({ conversationId: 1, timestamp: 1 });
messageSchema.index({ externalTicketId: 1, timestamp: 1 });
messageSchema.index({ customerId: 1, timestamp: -1 });
// markMessagesReadByCustomer: no leídos del agente por conversación
messageSchema.index({ conversationId: 1, senderType: 1, readByCustomerAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
