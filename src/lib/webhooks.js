/**
 * Entrega de webhooks con cola persistente, timeout y reintentos con backoff exponencial.
 *
 * enqueueWebhook() guarda el job en Mongo y despierta al worker → latencia casi inmediata.
 * Si el Sistema de Tickets cae, los jobs se reintentan (hasta WEBHOOK_MAX_ATTEMPTS)
 * y no se pierden aunque el proceso se reinicie.
 */

const WebhookJob = require('../models/WebhookJob');
const logger = require('./logger');

const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS) || 5000;
const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS) || 8;
const CONCURRENCY = Number(process.env.WEBHOOK_CONCURRENCY) || 5;
const POLL_INTERVAL_MS = Number(process.env.WEBHOOK_POLL_MS) || 5000;
const LOCK_MS = TIMEOUT_MS + 10_000;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

let running = false;
let active = 0;
let pollTimer = null;
let draining = false;
let rerunRequested = false;

function backoffMs(attempts) {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  return exp + Math.floor(Math.random() * 1000);
}

function isRetryableStatus(status) {
  return status >= 500 || status === 408 || status === 429;
}

async function deliver(job) {
  const response = await fetch(job.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.NOTIFICATIONS_API_KEY
    },
    body: JSON.stringify(job.payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (response.ok) {
    // Consumir el body para liberar el socket
    await response.arrayBuffer().catch(() => {});
    return { ok: true };
  }
  const body = await response.text().catch(() => '');
  return {
    ok: false,
    retryable: isRetryableStatus(response.status),
    error: `HTTP ${response.status}: ${body.slice(0, 200)}`
  };
}

async function claimNextJob() {
  const now = new Date();
  return WebhookJob.findOneAndUpdate(
    {
      status: 'pending',
      nextAttemptAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
    },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after' }
  ).lean();
}

async function processJob(job) {
  let result;
  try {
    result = await deliver(job);
  } catch (err) {
    result = { ok: false, retryable: true, error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }

  if (result.ok) {
    await WebhookJob.updateOne(
      { _id: job._id },
      { $set: { status: 'sent', lockedUntil: null, finishedAt: new Date(), lastError: '' } }
    );
    logger.info('webhook_sent', { label: job.label, attempts: job.attempts });
    return;
  }

  const exhausted = !result.retryable || job.attempts >= MAX_ATTEMPTS;
  await WebhookJob.updateOne(
    { _id: job._id },
    {
      $set: exhausted
        ? { status: 'failed', lockedUntil: null, finishedAt: new Date(), lastError: result.error }
        : {
          lockedUntil: null,
          lastError: result.error,
          nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts))
        }
    }
  );
  logger[exhausted ? 'error' : 'warn'](exhausted ? 'webhook_failed' : 'webhook_retry_scheduled', {
    label: job.label,
    attempts: job.attempts,
    error: result.error
  });
}

/** Procesa jobs disponibles respetando la concurrencia máxima. */
function drain() {
  if (!running) return;
  if (draining) {
    rerunRequested = true;
    return;
  }
  draining = true;
  rerunRequested = false;

  const fill = async () => {
    while (running && active < CONCURRENCY) {
      let job;
      try {
        job = await claimNextJob();
      } catch (err) {
        logger.error('webhook_claim_error', { error: err.message });
        break;
      }
      if (!job) break;
      active++;
      processJob(job)
        .catch((err) => logger.error('webhook_process_error', { error: err.message }))
        .finally(() => {
          active--;
          drain();
        });
    }
  };

  fill().finally(() => {
    draining = false;
    if (rerunRequested) drain();
  });
}

async function enqueueWebhook(payload, label = '') {
  const url = process.env.NOTIFICATIONS_API_URL;
  if (!url) return;
  try {
    await WebhookJob.create({ url, payload, label });
    drain();
  } catch (err) {
    logger.error('webhook_enqueue_failed', { label, error: err.message });
  }
}

function startWebhookWorker() {
  if (running) return;
  running = true;
  pollTimer = setInterval(drain, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  drain();
  logger.info('webhook_worker_started', { concurrency: CONCURRENCY, maxAttempts: MAX_ATTEMPTS });
}

function stopWebhookWorker() {
  running = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = {
  enqueueWebhook,
  startWebhookWorker,
  stopWebhookWorker
};
