/**
 * Llamadas de voz WebRTC (agente/funcionario → ciudadano).
 *
 * chat-core solo hace la señalización; el audio viaja directo entre los dos (o por TURN).
 *   1. Sistema de Tickets → POST /api/integrations/calls      → { callId, agentToken, iceServers }
 *   2. Panel  (/agent)    → call_join { callId, token }        → la app recibe call_incoming
 *   3. App    (/client)   → call_accept | call_reject
 *   4. Ambos              → call_signal { callId, data }       (offer, answer, candidate)
 *   5. Ambos              → call_end { callId }                → call_ended + registro en el chat
 *
 * Solo el Sistema de Tickets puede crear llamadas (decide quién puede llamar a quién);
 * el panel se une con el token de un solo uso que recibe al crearla.
 */

const crypto = require('crypto');
const Call = require('../models/Call');
const { authenticateRequest, isTicketsPlatform } = require('./auth');
const { DELIVERY_CHANNELS, findConversationByTicketId, recordMessage } = require('./messageStore');
const { badRequest, conflict, notFound, publicMessage } = require('./errors');
const { asString, asObjectId, safeAck } = require('./validate');
const logger = require('./logger');

const RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS) || 45_000;
/** Tiempo para reconectar el socket sin cortar la llamada (el audio WebRTC sigue mientras tanto). */
const DISCONNECT_GRACE_MS = Number(process.env.CALL_DISCONNECT_GRACE_MS) || 30_000;
/** Una llamada "activa" más vieja que esto se considera abandonada (no bloquea nuevas). */
const STALE_ACTIVE_MS = 4 * 60 * 60_000;
const ICE_TTL_SECONDS = Number(process.env.CALL_ICE_TTL_SECONDS) || 4 * 60 * 60;
const MAX_SIGNAL_BYTES = 64 * 1024;

const FALLBACK_ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

const callRoom = (callId) => `call-${callId}`;
const customerRoom = (platformId, customerId) => `customer-${platformId}-${customerId}`;
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ─── ICE servers (STUN/TURN) ────────────────────────────────────────────────

let iceCache = null; // { servers, expiresAt }

/**
 * Servidores ICE para RTCPeerConnection. Con CLOUDFLARE_TURN_KEY_ID/API_TOKEN genera
 * credenciales TURN temporales (se reutilizan la mitad de su vigencia); si no, solo STUN.
 */
async function getIceServers() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !apiToken) return FALLBACK_ICE_SERVERS;
  if (iceCache && iceCache.expiresAt > Date.now()) return iceCache.servers;

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: ICE_TTL_SECONDS }),
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!res.ok) throw new Error(`Cloudflare TURN respondió ${res.status}`);
    const data = await res.json();
    // Los navegadores bloquean el puerto 53: se quitan esas URLs.
    const servers = (data.iceServers || [])
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    if (!servers.length) throw new Error('Cloudflare TURN no devolvió servidores');
    iceCache = { servers, expiresAt: Date.now() + (ICE_TTL_SECONDS * 1000) / 2 };
    return servers;
  } catch (err) {
    logger.error('turn_credentials_failed', { error: err.message });
    return FALLBACK_ICE_SERVERS;
  }
}

// ─── Push a la app de Servicios Maracaibo (app cerrada / en segundo plano) ──

const PUSH_TIMEOUT_MS = 3000;

/**
 * POST {CALLS_PUSH_URL} con x-internal-key. Sin reintentos y con timeout corto: si falla, la
 * llamada sigue igual (los sockets conectados reciben call_incoming).
 * Devuelve { ok, error } y deja el resultado en la llamada para poder diagnosticar.
 */
async function sendCallPush(call, type) {
  const url = process.env.CALLS_PUSH_URL;
  const key = process.env.CALLS_PUSH_KEY;
  if (!url || !key) {
    logger.warn('call_push_not_configured', { callId: String(call._id) });
    return { ok: false, error: 'CALLS_PUSH_URL / CALLS_PUSH_KEY sin configurar' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({
        type,
        cedula: call.customerId,
        callId: String(call._id),
        callerName: call.agentName,
        ticketId: call.externalTicketId || '',
        caseNumber: call.caseNumber || ''
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
    });
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (!res.ok) {
      logger.warn('call_push_rejected', { callId: String(call._id), type, status: res.status, body });
      return { ok: false, error: `HTTP ${res.status} ${body}`.trim() };
    }
    logger.info('call_push_sent', { callId: String(call._id), type, response: body });
    return { ok: true, error: '' };
  } catch (err) {
    logger.warn('call_push_failed', { callId: String(call._id), type, url, error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Push de llamada entrante SIEMPRE (no solo sin socket): en Android la app suele mantener el socket
 * vivo en segundo plano y ese call_incoming no muestra pantalla. La app no la muestra dos veces.
 */
async function pushIncoming(call) {
  const { ok, error } = await sendCallPush(call, 'call');
  await Call.updateOne({ _id: call._id }, { $set: { pushSent: ok, pushError: error } });
}

/** La llamada dejó de sonar (contestada, perdida, rechazada o cancelada): quitar la notificación. */
async function pushCallEnd(callId) {
  const call = await Call.findOneAndUpdate(
    { _id: callId, pushSent: true, pushEndSent: { $ne: true } },
    { $set: { pushEndSent: true } },
    { returnDocument: 'after' }
  ).lean();
  if (!call) return;
  const { ok, error } = await sendCallPush(call, 'call_end');
  if (!ok) await Call.updateOne({ _id: callId }, { $set: { pushError: `call_end: ${error}` } });
}

// ─── Estado de la llamada ───────────────────────────────────────────────────

function toCallData(call) {
  return {
    callId: String(call._id),
    conversationId: String(call.conversationId),
    ticketId: call.externalTicketId || null,
    callerName: call.agentName,
    status: call.status,
    ringTimeoutMs: RING_TIMEOUT_MS,
    createdAt: call.createdAt,
    answeredAt: call.answeredAt || null
  };
}

function toCallHistoryData(call) {
  return {
    ...toCallData(call),
    agentId: call.agentId || null,
    endedAt: call.endedAt,
    durationMs: call.durationMs,
    endReason: call.endReason,
    endedBy: call.endedBy,
    recording: call.recording?.url || call.recording?.key ? call.recording : null
  };
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Deja constancia en el chat: "Llamada de voz 2:31", "Llamada perdida" o "Llamada rechazada".
 * Texto sin emojis: el panel le pone su icono según el texto.
 */
async function logCallInChat(call, io) {
  const text = call.answeredAt
    ? `Llamada de voz ${formatDuration(call.durationMs)}`
    : call.status === 'rejected'
      ? 'Llamada rechazada'
      : 'Llamada perdida';
  try {
    await recordMessage(
      {
        conversationId: call.conversationId,
        senderType: 'agent',
        messageType: 'text',
        content: text,
        // El registro lo firma el sistema, no el funcionario que llamó.
        senderName: call.systemName || 'Sistema',
        deliveryChannel: DELIVERY_CHANNELS.SOCKET_AGENT
      },
      io
    );
  } catch (err) {
    logger.error('call_log_message_failed', { callId: String(call._id), error: err.message });
  }
}

/**
 * Termina la llamada si sigue en uno de `from` (atómico: entre réplicas gana una sola).
 * Avisa a los dos lados con call_ended y registra la llamada en el chat.
 */
async function finishCall(io, callId, { from, status, reason, endedBy, filter = {} }) {
  const now = new Date();
  const call = await Call.findOneAndUpdate(
    { _id: callId, status: { $in: from }, ...filter },
    { $set: { status, endReason: reason, endedBy, endedAt: now } },
    { returnDocument: 'after' }
  );
  if (!call) return null;

  if (call.answeredAt) {
    call.durationMs = now - call.answeredAt;
    await Call.updateOne({ _id: call._id }, { $set: { durationMs: call.durationMs } });
  }

  const payload = { callId: String(call._id), status: call.status, reason, durationMs: call.durationMs };
  const room = callRoom(call._id);
  io.of('/agent').to(room).emit('call_ended', payload);
  io.of('/client').to([room, customerRoom(call.platformId, call.customerId)]).emit('call_ended', payload);
  logger.info('call_finished', { callId: payload.callId, status, reason, durationMs: call.durationMs });

  void logCallInChat(call, io);
  void pushCallEnd(call._id).catch(() => {});
  return call;
}

/** Crea la llamada (la invoca el Sistema de Tickets, que ya validó quién llama). */
async function createCall({ ticketId, agentName, agentId, systemName, caseNumber }, io) {
  const id = asString(ticketId, { max: 128 });
  if (!id) throw badRequest('ticketId es obligatorio');

  const conversation = await findConversationByTicketId(id, { activeOnly: true });
  if (!conversation) throw notFound('El caso no tiene un chat activo con el ciudadano');

  const now = Date.now();
  const busy = await Call.exists({
    platformId: conversation.platformId,
    customerId: conversation.customerId,
    $or: [
      { status: 'ringing', createdAt: { $gt: new Date(now - RING_TIMEOUT_MS - 5000) } },
      { status: 'active', answeredAt: { $gt: new Date(now - STALE_ACTIVE_MS) } }
    ]
  });
  if (busy) throw conflict('El ciudadano está en otra llamada');

  const agentToken = crypto.randomBytes(24).toString('hex');
  const call = await Call.create({
    conversationId: conversation._id,
    platformId: conversation.platformId,
    customerId: conversation.customerId,
    customerName: conversation.customerName,
    externalTicketId: conversation.externalTicketId || id,
    agentName: asString(agentName, { max: 120 }) || 'Agente',
    agentId: asString(agentId, { max: 64 }) || '',
    systemName: asString(systemName, { max: 120 }) || '',
    caseNumber: asString(caseNumber, { max: 40 }) || '',
    agentTokenHash: hashToken(agentToken)
  });

  // Nadie contestó a tiempo → perdida.
  setTimeout(() => {
    finishCall(io, call._id, { from: ['ringing'], status: 'missed', reason: 'no_answer', endedBy: 'system' })
      .catch((err) => logger.error('call_timeout_failed', { error: err.message }));
  }, RING_TIMEOUT_MS).unref();

  logger.info('call_created', { callId: String(call._id), ticketId: id });
  return { call, agentToken, iceServers: await getIceServers() };
}

/** Si nadie de ese lado vuelve a la sala de la llamada en el período de gracia, se corta. */
function scheduleDisconnectCheck(io, namespace, callId, endedBy) {
  setTimeout(async () => {
    try {
      const sockets = await io.of(namespace).in(callRoom(callId)).fetchSockets();
      if (sockets.length) return;
      await finishCall(io, callId, { from: ['ringing', 'active'], status: 'ended', reason: 'disconnected', endedBy });
    } catch (err) {
      logger.error('call_disconnect_check_failed', { error: err.message });
    }
  }, DISCONNECT_GRACE_MS).unref();
}

function callIdsOf(socket) {
  return [...socket.rooms].filter((r) => r.startsWith('call-')).map((r) => r.slice(5));
}

/** Reenvía offer/answer/candidate al otro lado. Solo quien está en la sala de la llamada. */
function relaySignal(socket, io, targetNamespace, data) {
  const callId = asObjectId(data?.callId);
  if (!callId || !socket.rooms.has(callRoom(callId))) return;
  const signal = data?.data;
  if (!signal || typeof signal !== 'object') return;
  if (Buffer.byteLength(JSON.stringify(signal)) > MAX_SIGNAL_BYTES) return;
  io.of(targetNamespace).to(callRoom(callId)).emit('call_signal', { callId, data: signal });
}

// ─── Socket /agent ──────────────────────────────────────────────────────────

function registerAgentCallHandlers(socket, io) {
  // El panel se une con el token que recibió el Sistema de Tickets; la primera vez hace sonar la app.
  socket.on('call_join', async (data, callback) => {
    const ack = safeAck(callback);
    try {
      const callId = asObjectId(data?.callId);
      const token = asString(data?.token, { max: 128 });
      if (!callId || !token) return ack({ success: false, error: 'callId y token son obligatorios' });

      const call = await Call.findById(callId).select('+agentTokenHash');
      const valid = call && crypto.timingSafeEqual(Buffer.from(call.agentTokenHash), Buffer.from(hashToken(token)));
      if (!valid) return ack({ success: false, error: 'Llamada no autorizada' });
      if (!['ringing', 'active'].includes(call.status)) {
        return ack({ success: false, error: 'La llamada ya terminó', status: call.status });
      }

      socket.join(callRoom(callId));

      const invited = await Call.findOneAndUpdate(
        { _id: callId, status: 'ringing', invitedAt: null },
        { $set: { invitedAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (invited) {
        io.of('/client')
          .to([customerRoom(invited.platformId, invited.customerId), String(invited.conversationId)])
          .emit('call_incoming', toCallData(invited));
        // Notificación push: suena aunque la app esté cerrada o en segundo plano.
        void pushIncoming(invited).catch((err) => logger.warn('call_push_check_failed', { error: err.message }));
      }

      ack({ success: true, call: toCallData(invited || call) });
    } catch (err) {
      logger.error('call_join_failed', { error: err.message });
      ack({ success: false, error: publicMessage(err) });
    }
  });

  socket.on('call_signal', (data) => relaySignal(socket, io, '/client', data));

  socket.on('call_end', async (data, callback) => {
    const ack = safeAck(callback);
    try {
      const callId = asObjectId(data?.callId);
      if (!callId || !socket.rooms.has(callRoom(callId))) return ack({ success: false, error: 'Llamada no encontrada' });
      const ended =
        (await finishCall(io, callId, { from: ['ringing'], status: 'cancelled', reason: 'caller_cancelled', endedBy: 'agent' })) ||
        (await finishCall(io, callId, { from: ['active'], status: 'ended', reason: 'hangup', endedBy: 'agent' }));
      ack({ success: true, ended: !!ended });
    } catch (err) {
      logger.error('call_end_failed', { error: err.message });
      ack({ success: false, error: publicMessage(err) });
    }
  });

  socket.on('disconnecting', () => {
    for (const callId of callIdsOf(socket)) {
      io.of('/client').to(callRoom(callId)).emit('call_peer_disconnected', { callId });
      scheduleDisconnectCheck(io, '/agent', callId, 'agent');
    }
  });
}

// ─── Socket /client ─────────────────────────────────────────────────────────

/** Llamadas que están sonando para este ciudadano (p. ej. abrió la app por la notificación). */
async function emitPendingCalls(socket) {
  const pending = await Call.find({
    platformId: socket.platform._id,
    customerId: socket.customerId,
    status: 'ringing',
    invitedAt: { $ne: null },
    createdAt: { $gt: new Date(Date.now() - RING_TIMEOUT_MS) }
  }).lean();
  for (const call of pending) socket.emit('call_incoming', toCallData(call));
}

function registerClientCallHandlers(socket, io) {
  const room = customerRoom(socket.platform._id, socket.customerId);
  const ownCall = { platformId: socket.platform._id, customerId: socket.customerId };
  socket.join(room);
  emitPendingCalls(socket).catch((err) => logger.error('call_pending_check_failed', { error: err.message }));

  socket.on('call_accept', async (data, callback) => {
    const ack = safeAck(callback);
    try {
      const callId = asObjectId(data?.callId);
      if (!callId) return ack({ success: false, error: 'callId es obligatorio' });

      const call = await Call.findOneAndUpdate(
        { _id: callId, status: 'ringing', ...ownCall },
        { $set: { status: 'active', answeredAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (!call) return ack({ success: false, error: 'La llamada ya no está disponible' });

      socket.join(callRoom(callId));
      // Otros dispositivos del mismo ciudadano dejan de sonar (también la notificación push).
      socket.to(room).emit('call_answered_elsewhere', { callId });
      void pushCallEnd(callId).catch(() => {});
      io.of('/agent').to(callRoom(callId)).emit('call_accepted', { callId });

      ack({ success: true, call: toCallData(call), iceServers: await getIceServers() });
    } catch (err) {
      logger.error('call_accept_failed', { error: err.message });
      ack({ success: false, error: publicMessage(err) });
    }
  });

  socket.on('call_reject', async (data, callback) => {
    const ack = safeAck(callback);
    try {
      const callId = asObjectId(data?.callId);
      if (!callId) return ack({ success: false, error: 'callId es obligatorio' });
      const call = await finishCall(io, callId, {
        from: ['ringing'], status: 'rejected', reason: 'rejected', endedBy: 'customer', filter: ownCall
      });
      ack({ success: !!call });
    } catch (err) {
      logger.error('call_reject_failed', { error: err.message });
      ack({ success: false, error: publicMessage(err) });
    }
  });

  // Tras reconectar el socket en plena llamada: volver a la sala para seguir recibiendo señales.
  socket.on('call_resume', async (data, callback) => {
    const ack = safeAck(callback);
    try {
      const callId = asObjectId(data?.callId);
      const call = callId && (await Call.findOne({ _id: callId, status: 'active', ...ownCall }).lean());
      if (!call) return ack({ success: false, error: 'La llamada ya terminó' });
      socket.join(callRoom(callId));
      ack({ success: true, call: toCallData(call), iceServers: await getIceServers() });
    } catch (err) {
      logger.error('call_resume_failed', { error: err.message });
      ack({ success: false, error: publicMessage(err) });
    }
  });

  socket.on('call_signal', (data) => relaySignal(socket, io, '/agent', data));

  socket.on('call_end', async (data, callback) => {
    const ack = safeAck(callback);
    try {
      const callId = asObjectId(data?.callId);
      if (!callId || !socket.rooms.has(callRoom(callId))) return ack({ success: false, error: 'Llamada no encontrada' });
      const ended = await finishCall(io, callId, {
        from: ['active'], status: 'ended', reason: 'hangup', endedBy: 'customer', filter: ownCall
      });
      ack({ success: true, ended: !!ended });
    } catch (err) {
      logger.error('call_end_failed', { error: err.message });
      ack({ success: false, error: publicMessage(err) });
    }
  });

  socket.on('disconnecting', () => {
    for (const callId of callIdsOf(socket)) {
      io.of('/agent').to(callRoom(callId)).emit('call_peer_disconnected', { callId });
      scheduleDisconnectCheck(io, '/client', callId, 'customer');
    }
  });
}

// ─── REST ───────────────────────────────────────────────────────────────────

function registerCallRoutes(expressApp, io) {
  /** Sistema de Tickets → crea una llamada al ciudadano del ticket. */
  expressApp.post('/api/integrations/calls', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isTicketsPlatform(platform)) {
      return res.status(403).json({ error: 'Solo el Sistema de Tickets puede iniciar llamadas' });
    }
    const { ticketId, agentName, agentId, systemName, caseNumber } = req.body || {};
    const { call, agentToken, iceServers } = await createCall({ ticketId, agentName, agentId, systemName, caseNumber }, io);
    res.status(201).json({ success: true, ...toCallData(call), agentToken, iceServers });
  });

  /** Historial de llamadas de un ticket. */
  expressApp.get('/api/integrations/calls', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isTicketsPlatform(platform)) {
      return res.status(403).json({ error: 'Solo el Sistema de Tickets puede consultar llamadas' });
    }
    const ticketId = asString(req.query.ticketId, { max: 128 });
    if (!ticketId) return res.status(400).json({ error: 'ticketId es obligatorio' });
    const calls = await Call.find({ externalTicketId: ticketId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, calls: calls.map(toCallHistoryData) });
  });

  /** Sistema de Tickets → guarda la grabación de una llamada contestada (subida antes al bucket). */
  expressApp.post('/api/integrations/calls/:callId/recording', async (req, res) => {
    const platform = await authenticateRequest(req);
    if (!isTicketsPlatform(platform)) {
      return res.status(403).json({ error: 'Solo el Sistema de Tickets puede guardar grabaciones' });
    }
    const callId = asObjectId(req.params.callId);
    if (!callId) return res.status(400).json({ error: 'callId inválido' });
    const { storage, bucket, key, url, mimeType, sizeBytes, durationMs, ticketId } = req.body || {};
    const isR2 = storage === 'r2';
    const cleanKey = asString(key, { max: 500 });
    const cleanUrl = asString(url, { max: 1000 });
    if (isR2 && (!cleanKey || !/^[\w./-]+$/.test(cleanKey) || cleanKey.includes('..'))) {
      return res.status(400).json({ error: 'key de la grabación inválida' });
    }
    if (!isR2 && (!cleanUrl || !/^https?:\/\//i.test(cleanUrl))) return res.status(400).json({ error: 'url de la grabación inválida' });
    if (!String(mimeType || '').startsWith('audio/')) return res.status(400).json({ error: 'La grabación debe ser audio' });

    // Solo llamadas contestadas del mismo ticket, y una sola grabación por llamada.
    const call = await Call.findOneAndUpdate(
      {
        _id: callId,
        externalTicketId: asString(ticketId, { max: 128 }) || '__none__',
        answeredAt: { $ne: null },
        'recording.url': { $in: ['', null] },
        'recording.key': { $in: ['', null] }
      },
      {
        $set: {
          recording: {
            storage: isR2 ? 'r2' : 'url',
            bucket: isR2 ? asString(bucket, { max: 120 }) : '',
            key: isR2 ? cleanKey : '',
            url: isR2 ? '' : cleanUrl,
            mimeType: asString(mimeType, { max: 60 }),
            sizeBytes: Number(sizeBytes) || 0,
            durationMs: Math.round(Number(durationMs)) || 0,
            uploadedAt: new Date()
          }
        }
      },
      { returnDocument: 'after' }
    ).lean();
    if (!call) return res.status(404).json({ error: 'Llamada no encontrada, sin contestar o ya grabada' });
    logger.info('call_recording_saved', { callId: String(callId), sizeBytes: call.recording.sizeBytes });
    res.status(201).json({ success: true, call: toCallHistoryData(call) });
  });
}

module.exports = {
  RING_TIMEOUT_MS,
  getIceServers,
  createCall,
  finishCall,
  toCallData,
  formatDuration,
  registerCallRoutes,
  registerAgentCallHandlers,
  registerClientCallHandlers
};
