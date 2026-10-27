/**
 * Llamada de voz WebRTC entre un agente/funcionario y el ciudadano de una conversación.
 * chat-core solo guarda el estado y reenvía la señalización; el audio no pasa por aquí.
 */

const mongoose = require('mongoose');

const CALL_STATUSES = ['ringing', 'active', 'ended', 'missed', 'rejected', 'cancelled'];

const callSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  platformId: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', required: true },
  customerId: { type: String, required: true },
  customerName: { type: String, default: '' },
  externalTicketId: { type: String, default: '' },
  /** Nombre que ve el ciudadano en la pantalla de llamada entrante. */
  agentName: { type: String, default: 'Agente' },
  /** Remitente de los avisos de la llamada en el chat (no es el agente: es el sistema). */
  systemName: { type: String, default: '' },
  /** Código del caso que ve el ciudadano (denuncia PM202610208 o ticket SM…), para el push. */
  caseNumber: { type: String, default: '' },
  /** Push a la app de Servicios Maracaibo: `call` al sonar y `call_end` al dejar de sonar (auditoría). */
  pushSent: { type: Boolean, default: false },
  pushEndSent: { type: Boolean, default: false },
  /** Último error del push (HTTP o red), para diagnosticar. */
  pushError: { type: String, default: '' },
  /** ID del usuario en el Sistema de Tickets (auditoría). */
  agentId: { type: String, default: '' },
  /** SHA-256 del token de un solo uso que autoriza al panel a unirse a la llamada. */
  agentTokenHash: { type: String, required: true, select: false },
  status: { type: String, enum: CALL_STATUSES, default: 'ringing' },
  /** Cuándo se hizo sonar al ciudadano (call_join del agente). */
  invitedAt: { type: Date, default: null },
  answeredAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  durationMs: { type: Number, default: 0 },
  endReason: { type: String, default: '' },
  /**
   * Grabación de la conversación (la sube el Sistema de Tickets al colgar).
   * storage 'r2': bucket privado de Cloudflare (se escucha con links firmados, `key`);
   * storage 'url': archivo público en `url` (grabaciones anteriores).
   */
  recording: {
    storage: { type: String, enum: ['', 'url', 'r2'], default: '' },
    bucket: { type: String, default: '' },
    key: { type: String, default: '' },
    url: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: null }
  },
  endedBy: { type: String, enum: ['agent', 'customer', 'system', ''], default: '' }
}, {
  timestamps: true
});

callSchema.index({ platformId: 1, customerId: 1, status: 1 });
callSchema.index({ conversationId: 1, createdAt: -1 });
callSchema.index({ externalTicketId: 1, createdAt: -1 });

module.exports = mongoose.model('Call', callSchema);
module.exports.CALL_STATUSES = CALL_STATUSES;
