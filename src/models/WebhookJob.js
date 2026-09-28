/**
 * Cola persistente (outbox) de webhooks salientes al Sistema de Tickets.
 * Sobrevive a reinicios y funciona con varias instancias (bloqueo por lockedUntil).
 */

const mongoose = require('mongoose');

const webhookJobSchema = new mongoose.Schema({
  label: { type: String, default: '' },
  url: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: {
    type: String,
    enum: ['pending', 'sent', 'failed'],
    default: 'pending'
  },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
  lastError: { type: String, default: '' },
  finishedAt: { type: Date, default: null }
}, {
  timestamps: true
});

webhookJobSchema.index({ status: 1, nextAttemptAt: 1 });
// Limpieza automática de jobs terminados (enviados o fallidos) a los 7 días
webhookJobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.model('WebhookJob', webhookJobSchema);
