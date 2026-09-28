/**
 * Pruebas de seguridad / robustez contra el server.js REAL.
 * No toca ninguna BDD externa: usa mongodb-memory-server y un webhook falso local.
 *
 * Ejecuta dos rondas:
 *   1. AUTH_ENFORCE=false (modo compatible, por defecto)
 *   2. AUTH_ENFORCE=true  (modo seguro)
 *
 * Uso: npm run test:hardening
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ioClient = require('socket.io-client');

const MARACAIBO_KEY = 'maracaibo_secret_key_2026';
const TICKETS_KEY = 'tickets_secret_key_2026';

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${details !== undefined ? ` → ${JSON.stringify(details)}` : ''}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Webhook falso: el primer POST de cada ticket responde 500 (para probar reintentos)
// ---------------------------------------------------------------------------
function startWebhookStub() {
  const received = [];
  const seenTickets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const firstTime = !seenTickets.has(payload.ticketId);
      seenTickets.add(payload.ticketId);
      received.push({ payload, apiKey: req.headers['x-api-key'], status: firstTime ? 500 : 200 });
      res.writeHead(firstTime ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const logs = [];
    child.stdout.on('data', (c) => logs.push(c.toString()));
    child.stderr.on('data', (c) => logs.push(c.toString()));
    child.on('exit', (code) => reject(new Error(`server.js salió con código ${code}\n${logs.join('')}`)));

    const started = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${env.PORT}/api/integrations/health`);
        if (res.ok) return resolve({ child, logs });
      } catch { /* aún no escucha */ }
      if (Date.now() - started > 20000) return reject(new Error(`timeout arrancando server.js\n${logs.join('')}`));
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function stopServer(child) {
  child.removeAllListeners('exit');
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
}

function api(base) {
  return async (method, urlPath, { key, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'X-Api-Key': key } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* no JSON */ }
    return { status: res.status, body: json, headers: res.headers };
  };
}

function connect(base, nsp, auth) {
  return new Promise((resolve) => {
    const socket = ioClient(`${base}${nsp}`, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
    socket.once('connect', () => resolve({ socket, ok: true }));
    socket.once('connect_error', (err) => resolve({ socket, ok: false, error: err.message }));
    setTimeout(() => resolve({ socket, ok: false, error: 'timeout' }), 4000);
  });
}

function emitAck(socket, event, ...args) {
  return new Promise((resolve) => {
    socket.emit(event, ...args, (res) => resolve(res));
    setTimeout(() => resolve({ success: false, error: 'timeout' }), 4000);
  });
}

function collect(socket, event) {
  const events = [];
  socket.on(event, (data) => events.push(data));
  return events;
}

// ---------------------------------------------------------------------------
// Ronda 1: modo compatible
// ---------------------------------------------------------------------------
async function runOpenMode(base, webhook) {
  const call = api(base);
  const ticket = `TK-HARD-${Date.now()}`;

  console.log('\n🔐 Fugas de datos / inyección');
  const link = await call('POST', '/api/integrations/conversations/link', {
    key: TICKETS_KEY,
    body: { ticketId: ticket, customerId: 'cust-A', customerName: 'Ana' }
  });
  check('link crea conversación', link.status === 201, link.body);

  const convs = await call('GET', '/api/conversations');
  const leaked = JSON.stringify(convs.body).includes('secret_key');
  check('GET /api/conversations no expone apiKey de plataformas', convs.status === 200 && !leaked);

  const inj = await connect(base, '/client', { apiKey: { $ne: null }, customerId: 'x', customerName: 'x' });
  check('socket /client rechaza apiKey con operador NoSQL', !inj.ok, inj.error);
  inj.socket.close();

  const injCust = await connect(base, '/client', { apiKey: MARACAIBO_KEY, customerId: { $ne: null }, customerName: 'x' });
  check('socket /client rechaza customerId con operador NoSQL', !injCust.ok, injCust.error);
  injCust.socket.close();

  const redos = await call('GET', `/api/departments/${encodeURIComponent('(a+)+$')}/availability?date=2026-10-01`);
  check('departmentId con regex malicioso → 404 (no se evalúa como patrón)', redos.status === 404, redos);

  const badId = await call('GET', '/api/conversations/no-es-un-id/history');
  check('ID inválido → 400 sin filtrar detalles internos', badId.status === 400 && !/Cast|mongoose/i.test(badId.body?.error), badId.body);

  const upload = await call('POST', '/api/uploads/image', { headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
  check('upload sin API Key → 401 antes de leer el archivo', upload.status === 401, upload.status);

  console.log('\n🌐 CORS');
  const evil = await call('GET', '/api/integrations/health', { headers: { Origin: 'http://localhost:3000.evil.com' } });
  check('origen "localhost:3000.evil.com" bloqueado', evil.status === 403, evil.status);
  const evil2 = await call('GET', '/api/integrations/health', { headers: { Origin: 'https://localhost.evil.com' } });
  check('origen "localhost.evil.com" bloqueado', evil2.status === 403, evil2.status);
  const good = await call('GET', '/api/integrations/health', { headers: { Origin: 'http://localhost:5173' } });
  check('origen localhost real permitido', good.status === 200, good.status);

  console.log('\n📅 Citas');
  const depts = await call('GET', '/api/departments');
  const dir = depts.body.data.find((d) => d.code === 'DIR'); // capacidad 4
  const date = '2026-11-02';
  const slot = '09:00 - 10:00';
  const mkAppointment = (i, extra = {}) => call('POST', '/api/appointments', {
    body: {
      departmentId: 'direccion',
      taxpayer: { name: `Contribuyente ${i}`, cedulaRif: `V-${1000 + i}`, email: `c${i}@x.com`, phone: '0414' },
      subject: 'Prueba',
      requestedDate: date,
      requestedTimeSlot: slot,
      ...extra
    }
  });

  const platforms = await call('GET', '/api/conversations'); // solo para tener el platformId
  const platformId = platforms.body[0]?.platformId?._id;
  const first = await mkAppointment(0, { platformId });
  check('crear cita por slug', first.status === 201, first.body);
  for (let i = 1; i < dir.capacityPerHour; i++) await mkAppointment(i);

  const avail = await call('GET', `/api/departments/direccion/availability?date=${date}`);
  const slotInfo = avail.body?.data?.slots?.find((s) => s.slot === slot);
  check('disponibilidad por slug cuenta las reservas reales', slotInfo?.booked === dir.capacityPerHour && slotInfo.available === false, slotInfo);

  const over = await mkAppointment(99);
  check('sobre-agendar un horario lleno → 409', over.status === 409, over.body);

  const badDate = await call('GET', '/api/departments/direccion/availability?date=mañana');
  check('fecha inválida → 400', badDate.status === 400, badDate.body);

  const badType = await call('PATCH', `/api/appointments/${first.body.data.id}/respond`, { body: { resolutionType: 'HACKEADO' } });
  check('resolutionType inválido → 400', badType.status === 400, badType.body);

  const msgs = await call('GET', `/api/appointments/${first.body.data.id}/messages`);
  check('mensajes de cita responde', msgs.status === 200 && Array.isArray(msgs.body.messages), msgs.body);

  // El ciudadano (sala = conversationId) recibe appointment_updated
  const cita = first.body.data;
  const citizen = await connect(base, '/client', {
    apiKey: MARACAIBO_KEY, customerId: cita.contributor.cedula, customerName: 'Contribuyente 0', ticketId: cita.appointmentCode
  });
  const joined = await emitAck(citizen.socket, 'join_chat');
  check('ciudadano se une al chat de la cita', joined.success && String(joined.conversationId) === cita.conversationId, joined);
  const updates = collect(citizen.socket, 'appointment_updated');
  await call('PATCH', `/api/appointments/${cita.id}/respond`, { body: { resolutionType: 'CONFIRMADA_PRESENCIAL', notes: 'ok' } });
  await wait(300);
  check('ciudadano recibe appointment_updated (bug room_ corregido)', updates.length === 1, updates.length);
  citizen.socket.close();

  console.log('\n💬 Tiempo real');
  const agent = await connect(base, '/agent', {});
  check('agente conecta (AUTH_ENFORCE=false)', agent.ok, agent.error);
  const agentMsgs = collect(agent.socket, 'new_message');
  const agentPresence = collect(agent.socket, 'client_presence');

  const c1 = await connect(base, '/client', { apiKey: MARACAIBO_KEY, customerId: 'cust-A', customerName: 'Ana', ticketId: ticket });
  const c2 = await connect(base, '/client', { apiKey: MARACAIBO_KEY, customerId: 'cust-A', customerName: 'Ana', ticketId: ticket });
  const j1 = await emitAck(c1.socket, 'join_chat');
  await emitAck(c2.socket, 'join_chat');
  agent.socket.emit('agent_join', { conversationId: String(j1.conversationId) });
  agent.socket.emit('agent_join'); // sin datos: antes lanzaba excepción
  await wait(200);

  const sent = await emitAck(c1.socket, 'send_message', { content: 'hola' });
  await wait(300);
  check('mensaje del ciudadano OK', sent.success, sent);
  check('agente en sala + dashboard recibe new_message UNA vez', agentMsgs.filter((m) => m.content === 'hola').length === 1, agentMsgs.length);

  agentPresence.length = 0;
  c2.socket.close();
  await wait(400);
  check('con otra pestaña abierta el ciudadano sigue online', !agentPresence.some((p) => p.online === false), agentPresence);
  c1.socket.close();
  await wait(400);
  check('al cerrar la última pestaña → offline', agentPresence.some((p) => p.online === false), agentPresence);

  const noAck = await new Promise((resolve) => {
    agent.socket.emit('close_conversation', { conversationId: '000000000000000000000000' }, resolve);
    setTimeout(() => resolve(null), 3000);
  });
  check('cerrar conversación inexistente → error controlado', noAck && noAck.success === false, noAck);

  // Rate limit del agente separado del ciudadano (antes: 10/min compartido)
  let agentOk = 0;
  for (let i = 0; i < 15; i++) {
    const r = await emitAck(agent.socket, 'agent_send_message', { conversationId: String(j1.conversationId), content: `m${i}` });
    if (r.success) agentOk++;
  }
  check('agente puede enviar más de 10 mensajes/min', agentOk === 15, agentOk);
  agent.socket.close();

  console.log('\n📡 Webhooks (cola con reintentos)');
  await wait(4500); // primer intento 500 → reintento con backoff ~2-3s
  const forTicket = webhook.received.filter((r) => r.payload.ticketId === ticket);
  check('webhook se reintenta tras un 500 y termina entregado', forTicket.length >= 2 && forTicket.some((r) => r.status === 200), forTicket.map((r) => r.status));
  check('webhook envía X-Api-Key', forTicket.every((r) => r.apiKey === TICKETS_KEY));

  console.log('\n⏱️ SLA overdue');
  const overdue = await call('GET', '/api/integrations/conversations/overdue?hours=-5', { key: TICKETS_KEY });
  check('hours negativo se acota (≥1)', overdue.status === 200 && overdue.body.hoursThreshold === 1, overdue.body?.hoursThreshold);
}

// ---------------------------------------------------------------------------
// Ronda 2: modo seguro
// ---------------------------------------------------------------------------
async function runStrictMode(base) {
  const call = api(base);
  const ticket = `TK-STRICT-${Date.now()}`;

  console.log('\n🛡️ AUTH_ENFORCE=true');
  const noKeyAgent = await connect(base, '/agent', {});
  check('/agent sin key → rechazado', !noKeyAgent.ok, noKeyAgent.error);
  noKeyAgent.socket.close();

  const citizenKeyAgent = await connect(base, '/agent', { apiKey: MARACAIBO_KEY });
  check('/agent con key pública de Maracaibo → rechazado', !citizenKeyAgent.ok, citizenKeyAgent.error);
  citizenKeyAgent.socket.close();

  const okAgent = await connect(base, '/agent', { apiKey: TICKETS_KEY });
  check('/agent con key de Tickets → conecta', okAgent.ok, okAgent.error);
  okAgent.socket.close();

  const r1 = await call('GET', '/api/conversations');
  const r2 = await call('GET', '/api/conversations', { key: MARACAIBO_KEY });
  const r3 = await call('GET', '/api/conversations', { key: TICKETS_KEY });
  check('/api/conversations: sin key 401, Maracaibo 403, Tickets 200', r1.status === 401 && r2.status === 403 && r3.status === 200, [r1.status, r2.status, r3.status]);

  const ap = await call('POST', '/api/appointments', { body: {} });
  check('crear cita sin key → 401', ap.status === 401, ap.status);
  const deps = await call('GET', '/api/departments', { key: MARACAIBO_KEY });
  check('departamentos con key de plataforma → 200', deps.status === 200, deps.status);
  const respond = await call('PATCH', '/api/appointments/000000000000000000000000/respond', { key: MARACAIBO_KEY, body: {} });
  check('responder cita con key de ciudadano → 403', respond.status === 403, respond.status);

  await call('POST', '/api/integrations/conversations/link', {
    key: TICKETS_KEY,
    body: { ticketId: ticket, customerId: 'owner', customerName: 'Dueño' }
  });
  const intruder = await connect(base, '/client', { apiKey: MARACAIBO_KEY, customerId: 'intruso', customerName: 'X', ticketId: ticket });
  const join = await emitAck(intruder.socket, 'join_chat');
  check('otro ciudadano NO puede tomar el ticket ajeno', join.success === false, join);
  intruder.socket.close();

  const owner = await connect(base, '/client', { apiKey: MARACAIBO_KEY, customerId: 'owner', customerName: 'Dueño', ticketId: ticket });
  const joinOwner = await emitAck(owner.socket, 'join_chat');
  check('el dueño sí puede unirse', joinOwner.success === true, joinOwner);
  owner.socket.close();
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  const webhook = await startWebhookStub();
  const baseEnv = {
    NODE_ENV: 'development',
    NOTIFICATIONS_API_URL: `http://127.0.0.1:${webhook.port}/notifications/ticket`,
    NOTIFICATIONS_API_KEY: TICKETS_KEY,
    MARACAIBO_API_KEY: MARACAIBO_KEY,
    BUCKET_UPLOAD_URL: 'http://127.0.0.1:9/upload',
    BUCKET_API_KEY: 'test',
    CORS_ALLOW_ALL: 'false',
    CORS_ALLOW_LAN: 'false',
    CORS_EXTRA_ORIGINS: '',
    PUBLIC_BASE_URL: '',
    REDIS_URL: '',
    LOG_LEVEL: 'warn'
  };

  const rounds = [
    { name: 'AUTH_ENFORCE=false', port: 4311, db: 'hard_open', env: { AUTH_ENFORCE: 'false' }, run: (b) => runOpenMode(b, webhook) },
    { name: 'AUTH_ENFORCE=true', port: 4312, db: 'hard_strict', env: { AUTH_ENFORCE: 'true' }, run: runStrictMode }
  ];

  try {
    for (const round of rounds) {
      console.log(`\n==================== ${round.name} ====================`);
      const { child, logs } = await startServer({
        ...baseEnv,
        ...round.env,
        PORT: String(round.port),
        MONGODB_URI: `${mongo.getUri()}${round.db}`
      });
      try {
        await round.run(`http://127.0.0.1:${round.port}`);
      } catch (err) {
        check(`ronda ${round.name} sin excepciones`, false, err.stack);
        console.error(logs.join(''));
      } finally {
        await stopServer(child);
      }
      const crashes = logs.join('').match(/uncaught_exception|unhandled_rejection/g);
      check(`sin excepciones no controladas en el servidor (${round.name})`, !crashes, crashes);
    }
  } finally {
    webhook.server.close();
    await mongo.stop();
  }

  console.log(`\n📊 ${passed} OK, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
