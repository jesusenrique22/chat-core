/**
 * Pruebas de la señalización de llamadas (WebRTC) contra un chat-core real con MongoDB en memoria.
 * No toca la base de datos de producción ni Cloudflare.
 * Uso: node scripts/test-calls.js
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ioClient = require('socket.io-client');

const PORT = 4097;
const BASE = `http://127.0.0.1:${PORT}`;
const MARACAIBO_KEY = 'test_maracaibo_key_calls';
const TICKETS_KEY = 'test_tickets_key_calls';
const TICKET_ID = 'TICKET-CALLS-1';
const TICKET_OFFLINE = 'TICKET-CALLS-2';
const PUSH_PORT = 4098;
const PUSH_KEY = 'push-test-key';
const AGENT_TOKEN_SECRET = 'test-agent-token-secret-calls';

// El socket /agent siempre exige credencial: token firmado por el panel, como en producción.
function agentAuth(sub = 'agente-1', name = 'Ana Agente') {
  const payload = Buffer.from(
    JSON.stringify({ sub, name, exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url');
  const sig = require('crypto').createHmac('sha256', AGENT_TOKEN_SECRET).update(payload).digest('hex');
  return { token: `${payload}.${sig}` };
}

// Servidor falso con el contrato de Servicios Maracaibo: POST /api/calls/push con x-internal-key.
const pushes = [];
const pushWaiters = [];
const pushServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const entry = { key: req.headers['x-internal-key'], body: JSON.parse(raw || '{}') };
    pushes.push(entry);
    pushWaiters.splice(0).forEach((w) => w(entry));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"sent":{"ios":true,"android":true}}');
  });
});
function nextPush(ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout esperando push')), ms);
    pushWaiters.push((e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

const ok = (name) => console.log(`✔ ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(pathname, { method = 'GET', key, body } = {}) {
  return fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Api-Key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

function connect(namespace, auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${BASE}${namespace}`, { auth, transports: ['websocket'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const citizen = (customerId = 'V1') =>
  connect('/client', { apiKey: MARACAIBO_KEY, customerId, customerName: 'Ana Pérez', ticketId: TICKET_ID });

function once(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function never(socket, event, ms = 400) {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`no debía llegar ${event}`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });
}

const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));

async function startCall(ticketId = TICKET_ID) {
  const res = await api('/api/integrations/calls', {
    method: 'POST',
    key: TICKETS_KEY,
    body: { ticketId, agentName: 'Mariana - Polimaracaibo', agentId: 'u1', systemName: 'Centro de Ayuda y Reclamos - Polimaracaibo', caseNumber: 'PM202610208' }
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function main() {
  await new Promise((r) => pushServer.listen(PUSH_PORT, '127.0.0.1', r));
  const mongo = await MongoMemoryServer.create();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      MONGODB_URI: mongo.getUri('calls'),
      REDIS_URL: '',
      MARACAIBO_API_KEY: MARACAIBO_KEY,
      NOTIFICATIONS_API_KEY: TICKETS_KEY,
      NOTIFICATIONS_API_URL: 'http://127.0.0.1:9/notifications/ticket',
      CLOUDFLARE_TURN_KEY_ID: '',
      CLOUDFLARE_TURN_API_TOKEN: '',
      CALL_RING_TIMEOUT_MS: '1500',
      CALL_DISCONNECT_GRACE_MS: '500',
      CALLS_PUSH_URL: `http://127.0.0.1:${PUSH_PORT}/api/calls/push`,
      CALLS_PUSH_KEY: PUSH_KEY,
      AGENT_TOKEN_SECRET,
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  const sockets = [];
  try {
    for (let i = 0; i < 60; i += 1) {
      const up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
      if (up) break;
      await sleep(250);
    }

    const link = await api('/api/integrations/conversations/link', {
      method: 'POST',
      key: TICKETS_KEY,
      body: { ticketId: TICKET_ID, customerId: 'V1', customerName: 'Ana Pérez' }
    });
    assert.strictEqual(link.status, 201, JSON.stringify(link.body));

    const phone = await citizen();
    const tablet = await citizen();
    const stranger = await connect('/client', { apiKey: MARACAIBO_KEY, customerId: 'V2', customerName: 'Otro', ticketId: 'OTRO' });
    const agent = await connect('/agent', agentAuth());
    sockets.push(phone, tablet, stranger, agent);
    assert.ok((await emit(phone, 'join_chat')).success);

    // ── Solo el Sistema de Tickets crea llamadas ──
    assert.ok([401, 403].includes((await api('/api/integrations/calls', { method: 'POST', body: { ticketId: TICKET_ID } })).status));
    assert.strictEqual((await api('/api/integrations/calls', { method: 'POST', key: MARACAIBO_KEY, body: { ticketId: TICKET_ID } })).status, 403);
    assert.strictEqual((await api('/api/integrations/calls', { method: 'POST', key: TICKETS_KEY, body: { ticketId: 'NO-EXISTE' } })).status, 404);
    ok('solo el Sistema de Tickets crea llamadas, y solo con chat activo');

    // ── Llamada contestada ──
    const call = await startCall();
    assert.ok(call.callId && call.agentToken && call.iceServers.length);
    assert.strictEqual((await api('/api/integrations/calls', { method: 'POST', key: TICKETS_KEY, body: { ticketId: TICKET_ID } })).status, 409);
    ok('crea la llamada con token e ICE servers; una segunda llamada da 409 (ocupado)');

    assert.strictEqual((await emit(agent, 'call_join', { callId: call.callId, token: 'falso' })).success, false);
    const ringPhone = once(phone, 'call_incoming');
    const ringTablet = once(tablet, 'call_incoming');
    const strangerRing = never(stranger, 'call_incoming');
    assert.ok((await emit(agent, 'call_join', { callId: call.callId, token: call.agentToken })).success);
    const incoming = await ringPhone;
    await ringTablet;
    await strangerRing;
    assert.strictEqual(incoming.callerName, 'Mariana - Polimaracaibo');
    ok('token falso rechazado; suenan todos los dispositivos del ciudadano y nadie más');

    assert.strictEqual((await emit(stranger, 'call_accept', { callId: call.callId })).success, false);
    const accepted = once(agent, 'call_accepted');
    const elsewhere = once(tablet, 'call_answered_elsewhere');
    const acceptAck = await emit(phone, 'call_accept', { callId: call.callId });
    assert.ok(acceptAck.success && acceptAck.iceServers.length);
    await accepted;
    await elsewhere;
    assert.strictEqual((await emit(tablet, 'call_accept', { callId: call.callId })).success, false);
    ok('otro ciudadano no puede contestar; al contestar, los demás dispositivos dejan de sonar');

    const offer = once(phone, 'call_signal');
    agent.emit('call_signal', { callId: call.callId, data: { type: 'offer', sdp: 'v=0 offer' } });
    assert.deepStrictEqual((await offer).data, { type: 'offer', sdp: 'v=0 offer' });
    const answer = once(agent, 'call_signal');
    phone.emit('call_signal', { callId: call.callId, data: { type: 'answer', sdp: 'v=0 answer' } });
    assert.strictEqual((await answer).data.type, 'answer');
    const leak = never(phone, 'call_signal');
    stranger.emit('call_signal', { callId: call.callId, data: { type: 'candidate', candidate: {} } });
    tablet.emit('call_signal', { callId: call.callId, data: { type: 'candidate', candidate: {} } });
    await leak;
    ok('offer/answer pasan entre los dos; terceros no pueden inyectar señales');

    await sleep(1100);
    const endedAgent = once(agent, 'call_ended');
    const logMsg = once(phone, 'new_message');
    assert.ok((await emit(phone, 'call_end', { callId: call.callId })).ended);
    const ended = await endedAgent;
    assert.strictEqual(ended.status, 'ended');
    assert.ok(ended.durationMs >= 1000);
    const log = await logMsg;
    assert.match(log.content, /^Llamada de voz 0:0[12]$/);
    assert.strictEqual(log.senderName, 'Centro de Ayuda y Reclamos - Polimaracaibo');
    ok('colgar termina la llamada en ambos lados y deja "Llamada de voz m:ss" en el chat, firmado por el sistema');

    // ── Perdida, rechazada, cancelada ──
    const missedCall = await startCall();
    await emit(agent, 'call_join', { callId: missedCall.callId, token: missedCall.agentToken });
    const missed = await once(agent, 'call_ended', 3000);
    assert.strictEqual(missed.status, 'missed');
    assert.match((await once(phone, 'new_message')).content, /Llamada perdida/);
    ok('sin respuesta → "missed" y "Llamada perdida" en el chat');

    const rejectCall = await startCall();
    await emit(agent, 'call_join', { callId: rejectCall.callId, token: rejectCall.agentToken });
    const rejected = once(agent, 'call_ended');
    assert.ok((await emit(phone, 'call_reject', { callId: rejectCall.callId })).success);
    assert.strictEqual((await rejected).status, 'rejected');
    ok('rechazar → "rejected"');

    const cancelCall = await startCall();
    await emit(agent, 'call_join', { callId: cancelCall.callId, token: cancelCall.agentToken });
    const cancelled = once(phone, 'call_ended');
    await emit(agent, 'call_end', { callId: cancelCall.callId });
    assert.strictEqual((await cancelled).status, 'cancelled');
    ok('el funcionario cuelga antes de que contesten → "cancelled" y deja de sonar');

    // ── App abierta después de que empezó a sonar ──
    const lateCall = await startCall();
    await emit(agent, 'call_join', { callId: lateCall.callId, token: lateCall.agentToken });
    const late = await citizen();
    sockets.push(late);
    assert.strictEqual((await once(late, 'call_incoming')).callId, lateCall.callId);
    ok('si la app se conecta mientras suena, recibe call_incoming al conectar');

    // ── Caída de conexión del funcionario ──
    await emit(late, 'call_accept', { callId: lateCall.callId });
    const peerDown = once(late, 'call_peer_disconnected');
    agent.disconnect();
    await peerDown;
    const dropped = await once(late, 'call_ended', 3000);
    assert.strictEqual(dropped.reason, 'disconnected');
    ok('si el funcionario se desconecta y no vuelve, la llamada se corta con reason "disconnected"');

    // ── Grabación ──
    const rec = { ticketId: TICKET_ID, url: 'https://bucket.test/llamada.webm', mimeType: 'audio/webm', sizeBytes: 5000, durationMs: 1500 };
    const recPath = (id) => `/api/integrations/calls/${id}/recording`;
    assert.strictEqual((await api(recPath(call.callId), { method: 'POST', key: MARACAIBO_KEY, body: rec })).status, 403);
    assert.strictEqual((await api(recPath(call.callId), { method: 'POST', key: TICKETS_KEY, body: { ...rec, ticketId: 'OTRO' } })).status, 404);
    assert.strictEqual((await api(recPath(call.callId), { method: 'POST', key: TICKETS_KEY, body: { ...rec, mimeType: 'image/png' } })).status, 400);
    const r2 = { ticketId: TICKET_ID, storage: 'r2', bucket: 'llamadas', key: `llamadas/2026/10/${TICKET_ID}/${call.callId}.webm`, mimeType: 'audio/webm', sizeBytes: 5000, durationMs: 1500 };
    assert.strictEqual((await api(recPath(call.callId), { method: 'POST', key: TICKETS_KEY, body: { ...r2, key: '../secreto' } })).status, 400);
    assert.strictEqual((await api(recPath(call.callId), { method: 'POST', key: TICKETS_KEY, body: r2 })).status, 201);
    assert.strictEqual((await api(recPath(call.callId), { method: 'POST', key: TICKETS_KEY, body: rec })).status, 404);
    assert.strictEqual((await api(recPath(missedCall.callId), { method: 'POST', key: TICKETS_KEY, body: rec })).status, 404);
    ok('grabación en R2: solo Tickets, key válida, solo llamadas contestadas del mismo ticket y una sola vez');

    const history = await api(`/api/integrations/calls?ticketId=${TICKET_ID}`, { key: TICKETS_KEY });
    const withRec = history.body.calls.find((c) => c.callId === call.callId);
    assert.deepStrictEqual(
      { storage: withRec.recording.storage, bucket: withRec.recording.bucket, key: withRec.recording.key },
      { storage: 'r2', bucket: 'llamadas', key: r2.key }
    );
    assert.deepStrictEqual(history.body.calls.map((c) => c.status).sort(), ['cancelled', 'ended', 'ended', 'missed', 'rejected']);
    ok('historial de llamadas del ticket');

    // ── Push a la app (siempre, aunque tenga socket: en segundo plano no muestra pantalla) ──
    assert.ok(pushes.some((p) => p.body.type === 'call' && p.body.cedula === 'V1'));
    ok('con socket conectado también se envía push "call" (Android en segundo plano)');
    pushes.length = 0;

    await api('/api/integrations/conversations/link', {
      method: 'POST',
      key: TICKETS_KEY,
      body: { ticketId: TICKET_OFFLINE, customerId: 'V3', customerName: 'Sin App' }
    });
    const agent2 = await connect('/agent', agentAuth('agente-2', 'Beto Agente'));
    sockets.push(agent2);

    const offline = await startCall(TICKET_OFFLINE);
    const ringPush = nextPush();
    const joinStarted = Date.now();
    assert.ok((await emit(agent2, 'call_join', { callId: offline.callId, token: offline.agentToken })).success);
    assert.ok(Date.now() - joinStarted < 1000, 'el push no debe demorar la llamada');
    const sent = await ringPush;
    assert.strictEqual(sent.key, PUSH_KEY);
    assert.deepStrictEqual(sent.body, {
      type: 'call',
      cedula: 'V3',
      callId: offline.callId,
      callerName: 'Mariana - Polimaracaibo',
      ticketId: TICKET_OFFLINE,
      caseNumber: 'PM202610208'
    });
    ok('app cerrada: push "call" con cédula, callId, callerName, ticketId y caseNumber');

    const endPush = await nextPush(4000);
    assert.deepStrictEqual({ type: endPush.body.type, callId: endPush.body.callId }, { type: 'call_end', callId: offline.callId });
    ok('si nadie contesta (perdida), push "call_end" con el mismo callId');

    const second = await startCall(TICKET_OFFLINE);
    const ring2 = nextPush();
    await emit(agent2, 'call_join', { callId: second.callId, token: second.agentToken });
    assert.strictEqual((await ring2).body.type, 'call');
    // El ciudadano abre la app desde la notificación: recibe call_incoming al conectar y contesta.
    const opened = await connect('/client', { apiKey: MARACAIBO_KEY, customerId: 'V3', customerName: 'Sin App', ticketId: TICKET_OFFLINE });
    sockets.push(opened);
    assert.strictEqual((await once(opened, 'call_incoming')).callId, second.callId);
    const answeredPush = nextPush();
    assert.ok((await emit(opened, 'call_accept', { callId: second.callId })).success);
    assert.deepStrictEqual({ type: (await answeredPush).body.type }, { type: 'call_end' });
    const pushCount = pushes.length;
    await emit(opened, 'call_end', { callId: second.callId });
    await sleep(300);
    assert.strictEqual(pushes.length, pushCount, 'no se repite call_end al colgar');
    ok('abrió la app desde el push y contestó: call_incoming al conectar y push "call_end" una sola vez');

    // El fallo del push queda registrado en la llamada para diagnosticar.
    pushServer.close();
    const broken = await startCall(TICKET_OFFLINE);
    await emit(agent2, 'call_join', { callId: broken.callId, token: broken.agentToken });
    await sleep(800);
    const listed = await api(`/api/integrations/calls?ticketId=${TICKET_OFFLINE}`, { key: TICKETS_KEY });
    assert.ok(listed.status === 200);
    await emit(agent2, 'call_end', { callId: broken.callId });
    ok('si el servidor de push no responde, la llamada sigue y no se cae nada');

    console.log('\nTodas las pruebas de llamadas pasaron.');
  } finally {
    sockets.forEach((s) => s.disconnect());
    pushServer.close();
    server.kill();
    await mongo.stop();
  }
}

main().catch((err) => {
  console.error('✘', err);
  process.exit(1);
});
