/**
 * Pruebas de la puerta de tickets de la app ciudadana contra un chat-core real con MongoDB en
 * memoria y un Sistema de Tickets falso. No toca la base de datos de producción.
 * Uso: node scripts/test-ticket-gateway.js
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ioClient = require('socket.io-client');

const PORT = 4096;
const PORT_NO_SECRET = 4095;
const TICKETS_PORT = 4094;
const SM_PORT = 4093;
const PORT_SM_ONLY = 4092;
const SM_ME_URL = `http://127.0.0.1:${SM_PORT}/api/auth/me`;
const SM_SESSION = 'v3.local.sesion-valida';
const BASE = `http://127.0.0.1:${PORT}`;
const MARACAIBO_KEY = 'test_maracaibo_key_gateway';
const TICKETS_KEY = 'test_tickets_key_gateway';
const CITIZEN_SECRET = 'test-citizen-secret';

const ok = (name) => console.log(`✔ ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function citizenToken(cedula, { name = 'Ana Pérez', exp = Date.now() / 1000 + 3600, secret = CITIZEN_SECRET } = {}) {
  const payload = Buffer.from(JSON.stringify({ sub: cedula, name, exp: Math.floor(exp) })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

// Sistema de Tickets falso: mismo contrato que /integrations/chat-core/tickets.
const fake = { tickets: new Map(), requests: [], down: false, seq: 0 };
const normalize = (v) => String(v || '').toUpperCase().replace(/[\s.-]/g, '');

const ticketsServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    fake.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, key: req.headers['x-api-key'] });
    const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

    if (fake.down) return send(500, { success: false, error: 'secreto interno de tickets' });
    if (req.headers['x-api-key'] !== TICKETS_KEY) return send(401, { success: false, error: 'API Key inválida' });

    const [, id, sub] = url.pathname.replace('/integrations/chat-core/tickets', '').split('/');
    if (!id && req.method === 'POST') {
      if (!body.title) return send(400, { success: false, error: 'Título obligatorio' });
      const ticket = { _id: `ticket${++fake.seq}`, title: body.title, cedula: body.cedula, status: 'ABIERTO' };
      fake.tickets.set(ticket._id, ticket);
      return send(201, { success: true, data: ticket });
    }
    if (!id) {
      const data = [...fake.tickets.values()].filter((t) => normalize(t.cedula) === normalize(url.searchParams.get('cedula')));
      return send(200, { success: true, count: data.length, data });
    }
    const ticket = fake.tickets.get(decodeURIComponent(id));
    if (!ticket) return send(404, { success: false, error: 'Ticket no encontrado' });
    if (sub === 'status' && req.method === 'GET') return send(200, { success: true, data: { status: ticket.status } });

    const cedula = req.method === 'GET' ? url.searchParams.get('cedula') : body.cedula;
    if (normalize(ticket.cedula) !== normalize(cedula)) return send(404, { success: false, error: 'Ticket no encontrado' });
    if (sub === 'status') {
      ticket.status = body.status;
      return send(200, { success: true, data: { _id: ticket._id, status: body.status } });
    }
    return send(200, { success: true, data: ticket });
  });
});

// API de Servicios Maracaibo falsa: misma forma de respuesta que GET /api/auth/me.
const sm = { calls: 0 };
const smServer = http.createServer((req, res) => {
  const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  // Bucket falso: acepta el archivo y devuelve su URL pública.
  if (req.url === '/upload') {
    req.resume();
    return req.on('end', () => send(201, { url: 'https://bucket.example/ticket_chat/oficio.pdf', key: 'k', contentType: 'application/pdf', size: 20 }));
  }
  sm.calls += 1;
  const auth = req.headers.authorization;
  if (auth === 'Bearer v3.local.sm-caido') return send(500, { message: 'error interno' });
  if (auth === 'Bearer v3.local.sin-dni') return send(200, { id: 'u2', name: 'SIN CEDULA' });
  if (auth !== `Bearer ${SM_SESSION}`) return send(401, { statusCode: 401, message: 'Token PASETO inválido' });
  return send(200, {
    id: '9c1d7e3a-2b4f-4a6e-8d0c-1f3b5a7e9d22',
    email: 'usuario.prueba@example.com',
    name: 'USUARIO PRUEBA',
    role: 'user',
    dni: 'V9900000',
    customerId: '4a459ebf-6d0f-489d-89b8-bcc4b03c6adf'
  });
});

function api(pathname, { method = 'GET', key = MARACAIBO_KEY, token, body, base = BASE } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Api-Key': key } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

function connect(customerId, ticketId) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${BASE}/client`, {
      auth: { apiKey: MARACAIBO_KEY, customerId, customerName: 'Ana Pérez', ticketId },
      transports: ['websocket'],
      forceNew: true
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const emit = (socket, event, data = {}) => new Promise((resolve) => socket.emit(event, data, resolve));

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

function startServer(port, dbUri, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CHAT_CORE_SKIP_DOTENV: 'true',
      PORT: String(port),
      NODE_ENV: 'test',
      MONGODB_URI: dbUri,
      REDIS_URL: '',
      CORS_ALLOW_LAN: 'false',
      CORS_ALLOW_ALL: 'true',
      BUCKET_UPLOAD_URL: 'http://127.0.0.1:9/upload',
      BUCKET_API_KEY: 'x',
      MARACAIBO_API_KEY: MARACAIBO_KEY,
      NOTIFICATIONS_API_KEY: TICKETS_KEY,
      NOTIFICATIONS_API_URL: `http://127.0.0.1:${TICKETS_PORT}/notifications/ticket`,
      CALLS_PUSH_URL: '',
      LOG_LEVEL: 'silent',
      ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  return child;
}

async function waitUp(base) {
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`no arrancó ${base}`);
}

async function createTicket(cedula = 'V-1', title = 'Caso') {
  const res = await api('/api/integrations/tickets', { method: 'POST', token: citizenToken(cedula), body: { title, description: 'd' } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const statusChanged = (ticketId, body, key = TICKETS_KEY) =>
  api(`/api/integrations/tickets/${ticketId}/status-changed`, { method: 'POST', key, body });

const closeChat = (ticketId) =>
  api(`/api/integrations/conversations/${ticketId}/close`, { method: 'POST', key: TICKETS_KEY, body: { closedBy: 'Ana' } });

async function main() {
  await new Promise((r) => ticketsServer.listen(TICKETS_PORT, '127.0.0.1', r));
  await new Promise((r) => smServer.listen(SM_PORT, '127.0.0.1', r));
  const mongo = await MongoMemoryServer.create();
  const server = startServer(PORT, mongo.getUri('gateway'), { CITIZEN_TOKEN_SECRET: CITIZEN_SECRET, SM_AUTH_ME_URL: '' });
  const noSecret = startServer(PORT_NO_SECRET, mongo.getUri('gateway2'), { CITIZEN_TOKEN_SECRET: '', SM_AUTH_ME_URL: '' });
  // Como en producción: solo la sesión de SM, sin tokens firmados.
  const smOnly = startServer(PORT_SM_ONLY, mongo.getUri('gateway3'), {
    CITIZEN_TOKEN_SECRET: '',
    SM_AUTH_ME_URL: SM_ME_URL,
    BUCKET_UPLOAD_URL: `http://127.0.0.1:${SM_PORT}/upload`
  });
  const sockets = [];
  const open = async (...args) => {
    const socket = await connect(...args);
    sockets.push(socket);
    return socket;
  };

  try {
    await Promise.all([waitUp(BASE), waitUp(`http://127.0.0.1:${PORT_NO_SECRET}`), waitUp(`http://127.0.0.1:${PORT_SM_ONLY}`)]);

    // ── Identidad ──
    assert.strictEqual(
      (await api('/api/integrations/tickets', { token: citizenToken('V-1'), base: `http://127.0.0.1:${PORT_NO_SECRET}` })).status,
      503
    );
    ok('sin CITIZEN_TOKEN_SECRET la puerta queda cerrada');

    assert.strictEqual((await api('/api/integrations/tickets')).status, 401);
    assert.strictEqual((await api('/api/integrations/tickets', { token: citizenToken('V-1', { secret: 'otro' }) })).status, 401);
    assert.strictEqual((await api('/api/integrations/tickets', { token: citizenToken('V-1', { exp: Date.now() / 1000 - 5 }) })).status, 401);
    ok('sin token, con firma falsa o vencido: 401');

    assert.strictEqual((await api('/api/integrations/tickets', { key: TICKETS_KEY, token: citizenToken('V-1') })).status, 403);
    ok('la key de Tickets no sirve en las rutas del ciudadano');

    // ── Crear ──
    const before = fake.requests.length;
    const res = await api('/api/integrations/tickets', {
      method: 'POST',
      token: citizenToken('V-1'),
      body: { title: 'Bache', description: 'd', cedula: 'V-999', assignedTo: 'Otro', created_by: 'Falso' }
    });
    assert.strictEqual(res.status, 201);
    const sent = fake.requests[before].body;
    assert.strictEqual(sent.cedula, 'V-1');
    assert.strictEqual(sent.assignedTo, undefined);
    assert.strictEqual(sent.created_by, undefined);
    assert.ok(res.body.conversationId, 'debe enlazar el chat');
    ok('la cédula sale del token, no del cuerpo; responsable y creador no se aceptan; el chat queda enlazado');

    const ticketId = res.body.data._id;
    const invalid = await api('/api/integrations/tickets', { method: 'POST', token: citizenToken('V-1'), body: { description: 'sin título' } });
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.error, 'Título obligatorio');
    ok('los errores de validación de Tickets llegan a la app');

    // ── Consultar ──
    const foreign = (await createTicket('V-2', 'Ajeno')).data._id;
    const list = await api('/api/integrations/tickets?cedula=V-2', { token: citizenToken('V-1') });
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.data.every((t) => t.cedula === 'V-1'), 'solo sus tickets');
    assert.strictEqual((await api(`/api/integrations/tickets/${ticketId}`, { token: citizenToken('V1') })).status, 200);
    assert.strictEqual((await api(`/api/integrations/tickets/${foreign}`, { token: citizenToken('V-1') })).status, 404);
    ok('solo ve sus tickets: ?cedula= no cambia la identidad y un ticket ajeno da 404');

    // ── Cambiar status ──
    assert.strictEqual(
      (await api(`/api/integrations/tickets/${foreign}/status`, { method: 'PATCH', token: citizenToken('V-1'), body: { status: 'CERRADO', cedula: 'V-2' } })).status,
      404
    );
    assert.strictEqual(fake.tickets.get(foreign).status, 'ABIERTO');
    const patched = await api(`/api/integrations/tickets/${ticketId}/status`, { method: 'PATCH', token: citizenToken('V-1'), body: { status: 'EN_PROGRESO' } });
    assert.strictEqual(patched.status, 200);
    ok('no puede cambiar el status de un ticket ajeno, aunque envíe esa cédula; el suyo sí');

    // ── Tickets caído ──
    fake.down = true;
    const down = await api('/api/integrations/tickets', { token: citizenToken('V-1') });
    fake.down = false;
    assert.strictEqual(down.status, 502);
    assert.ok(!JSON.stringify(down.body).includes('secreto'), 'no filtra errores internos');
    ok('con Tickets fallando responde 502 sin filtrar el error interno');

    // ── Status en tiempo real ──
    const chat = await open('V1', ticketId);
    await emit(chat, 'join_chat');
    const otherScreen = await open('V-1', 'otro-ticket');
    const stranger = await open('V-2', foreign);
    await emit(stranger, 'join_chat');

    const strangerSilent = never(stranger, 'ticket_status_changed');
    const [inChat, inOther] = await Promise.all([
      once(chat, 'ticket_status_changed'),
      once(otherScreen, 'ticket_status_changed'),
      statusChanged(ticketId, { status: 'Caso en progreso', closed: false, customerId: 'V-1' })
    ]);
    await strangerSilent;
    assert.deepStrictEqual([inChat.ticketId, inChat.status, inChat.closed], [ticketId, 'Caso en progreso', false]);
    assert.strictEqual(inOther.status, 'Caso en progreso');
    ok('ticket_status_changed llega al ciudadano aunque esté en otra pantalla, sin importar el formato de cédula; no a otros');

    const delivered = await Promise.all([
      once(otherScreen, 'ticket_status_changed'),
      statusChanged('ticket-sin-chat', { status: 'Caso abierto', customerId: 'V-1' })
    ]);
    assert.strictEqual(delivered[0].ticketId, 'ticket-sin-chat');
    ok('también llega si el ticket todavía no tiene chat');

    assert.strictEqual((await statusChanged(ticketId, { status: 'X' }, MARACAIBO_KEY)).status, 403);
    ok('la app no puede fabricar avisos de status');

    // ── Reapertura: caso resuelto sí, caso cerrado no ──
    fake.tickets.get(ticketId).status = 'RESUELTO';
    await closeChat(ticketId);
    const reply = await emit(chat, 'send_message', { messageType: 'text', content: 'sigue fallando' });
    assert.strictEqual(reply.success, true, JSON.stringify(reply));
    ok('en un caso RESUELTO el ciudadano puede responder y el chat se reabre');

    fake.tickets.get(ticketId).status = 'CERRADO';
    await closeChat(ticketId);
    const rejected = await emit(chat, 'send_message', { messageType: 'text', content: 'hola' });
    assert.strictEqual(rejected.success, false);
    assert.strictEqual(rejected.code, 'CONVERSATION_CLOSED');
    ok('con el chat abierto en pantalla, un caso CERRADO ya no admite mensajes');

    const rejoined = await open('V-1', ticketId);
    const joined = await emit(rejoined, 'join_chat');
    assert.strictEqual(joined.success, true);
    assert.strictEqual(joined.conversationStatus, 'closed');
    assert.ok(joined.messages.some((m) => m.content === 'sigue fallando'), 'conserva el historial');
    assert.strictEqual((await emit(rejoined, 'send_message', { messageType: 'text', content: 'hola' })).code, 'CONVERSATION_CLOSED');
    ok('al entrar a un caso CERRADO se lee el historial, pero no se reabre');

    const linked = await api('/api/integrations/conversations/link', {
      method: 'POST',
      key: TICKETS_KEY,
      body: { ticketId, customerId: 'V-1', customerName: 'Ana Pérez' }
    });
    assert.strictEqual(linked.status, 201);
    assert.strictEqual(linked.body.status, 'closed');
    assert.ok(linked.body.conversationId);
    ok('abrir un caso CERRADO en el panel tampoco lo reabre');

    // ── Sin respuesta de Tickets no se reabre ──
    const down2 = (await createTicket('V-3')).data._id;
    await closeChat(down2);
    fake.down = true;
    const cautious = await open('V-3', down2);
    const ack = await emit(cautious, 'join_chat');
    fake.down = false;
    assert.strictEqual(ack.conversationStatus, 'closed');
    ok('si Tickets no responde, el chat cerrado sigue cerrado');

    // ── Ticket que Tickets no conoce: se mantiene el comportamiento anterior ──
    await api('/api/integrations/conversations/link', {
      method: 'POST',
      key: TICKETS_KEY,
      body: { ticketId: 'LEGADO-1', customerId: 'V-4', customerName: 'Luis' }
    });
    await closeChat('LEGADO-1');
    const legacy = await open('V-4', 'LEGADO-1');
    assert.strictEqual((await emit(legacy, 'join_chat')).conversationStatus, 'active');
    ok('una conversación sin ticket en el sistema se puede retomar como antes');

    // ── Sesión de Servicios Maracaibo (accessToken que devuelve su login) ──
    const smBase = `http://127.0.0.1:${PORT_SM_ONLY}`;
    const smApi = (pathname, options) => api(pathname, { base: smBase, ...options });

    const smBefore = fake.requests.length;
    const smTicket = await smApi('/api/integrations/tickets', {
      method: 'POST',
      token: SM_SESSION,
      body: { title: 'Fuga', description: 'd', cedula: 'V-999' }
    });
    assert.strictEqual(smTicket.status, 201, JSON.stringify(smTicket.body));
    assert.strictEqual(fake.requests[smBefore].body.cedula, 'V9900000');
    assert.strictEqual(fake.requests[smBefore].body.customerName, 'USUARIO PRUEBA');
    ok('con la sesión de SM la cédula sale de /auth/me, no de lo que envía la app');

    const smList = await smApi('/api/integrations/tickets', { token: SM_SESSION });
    assert.strictEqual(smList.status, 200);
    assert.ok(smList.body.data.length > 0 && smList.body.data.every((t) => t.cedula === 'V9900000'));
    ok('lista solo los tickets de la cédula de esa sesión');

    const callsAfterList = sm.calls;
    await smApi('/api/integrations/tickets', { token: SM_SESSION });
    assert.strictEqual(sm.calls, callsAfterList);
    ok('no consulta a SM en cada petición');

    assert.strictEqual((await smApi('/api/integrations/tickets', { token: 'v3.local.vencido' })).status, 401);
    assert.strictEqual((await smApi('/api/integrations/tickets', { token: 'v3.local.sin-dni' })).status, 401);
    assert.strictEqual((await smApi('/api/integrations/tickets', { token: citizenToken('V-1') })).status, 401);
    ok('sesión rechazada, sin cédula o token firmado sin secreto configurado: 401');

    const smDown = await smApi('/api/integrations/tickets', { token: 'v3.local.sm-caido' });
    assert.strictEqual(smDown.status, 503);
    ok('si SM falla responde 503 y no deja entrar');

    const smSocket = (auth) => new Promise((resolve, reject) => {
      const socket = ioClient(`${smBase}/client`, {
        auth: { apiKey: MARACAIBO_KEY, ...auth },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
      });
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

    const smChat = await smSocket({
      token: SM_SESSION,
      ticketId: smTicket.body.data._id,
      customerId: '4a459ebf-6d0f-489d-89b8-bcc4b03c6adf'
    });
    const smJoin = await emit(smChat, 'join_chat');
    assert.strictEqual(smJoin.success, true, JSON.stringify(smJoin));
    assert.strictEqual(smJoin.conversationId, smTicket.body.conversationId);
    assert.strictEqual((await emit(smChat, 'send_message', { messageType: 'text', content: 'hola' })).success, true);
    ok('el socket con la sesión de SM entra al chat del ticket, aunque customerId sea el UUID de SM');

    await assert.rejects(smSocket({ token: 'v3.local.vencido', customerId: 'V9900000', customerName: 'X' }), /token de cliente inválido/);
    ok('una sesión inválida no entra al socket aunque declare una cédula');

    // ── Nombre y foto del agente ──
    const agentSays = (body) => api('/api/integrations/messages', {
      base: smBase,
      method: 'POST',
      key: TICKETS_KEY,
      body: { ticketId: smTicket.body.data._id, ...body }
    });
    const FOTO = 'https://bucket.example/ticket_chat/mariana.png';
    const [withPhoto] = await Promise.all([
      once(smChat, 'new_message'),
      agentSays({ content: 'Hola, soy Mariana', agentName: 'Mariana Castellanos', agentAvatarUrl: FOTO })
    ]);
    assert.strictEqual(withPhoto.senderName, 'Mariana Castellanos');
    assert.strictEqual(withPhoto.senderAvatarUrl, FOTO);
    ok('new_message llega a la app con el nombre y la foto del agente');

    const [noPhoto] = await Promise.all([
      once(smChat, 'new_message'),
      agentSays({ content: 'Sin foto', agentName: 'Nelson' })
    ]);
    assert.strictEqual(noPhoto.senderAvatarUrl, '');
    const [badPhoto] = await Promise.all([
      once(smChat, 'new_message'),
      agentSays({ content: 'URL insegura', agentName: 'Nelson', agentAvatarUrl: 'javascript:alert(1)' })
    ]);
    assert.strictEqual(badPhoto.senderAvatarUrl, '');
    ok('sin foto o con una URL que no es https, el mensaje sale sin foto');

    const smHistory = await emit(smChat, 'join_chat');
    assert.strictEqual(smHistory.messages.find((m) => m.content === 'Hola, soy Mariana').senderAvatarUrl, FOTO);
    ok('el historial conserva la foto');

    // ── Documentos PDF ──
    const uploadFile = async (bytes, { name = 'oficio.pdf', type = 'application/pdf' } = {}) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      const res = await fetch(`${smBase}/api/uploads/file`, { method: 'POST', headers: { 'X-Api-Key': MARACAIBO_KEY }, body: form });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const PDF = Buffer.from('%PDF-1.7\nprueba\n%%EOF');

    const uploaded = await uploadFile(PDF);
    assert.strictEqual(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.strictEqual(uploaded.body.mimeType, 'application/pdf');
    assert.strictEqual(uploaded.body.fileName, 'oficio.pdf');
    assert.strictEqual((await uploadFile(PDF, { name: 'sin-extension', type: 'application/octet-stream' })).body.fileName, 'sin-extension.pdf');
    ok('sube un PDF al bucket, también desde clientes que envían octet-stream');

    assert.strictEqual((await uploadFile(Buffer.from('<script>alert(1)</script>'))).status, 400);
    assert.strictEqual((await uploadFile(PDF, { type: 'text/html' })).status, 400);
    const tooBig = await uploadFile(Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]));
    assert.strictEqual(tooBig.status, 400);
    assert.match(tooBig.body.error, /10 MB/);
    const noKey = await fetch(`${smBase}/api/uploads/file`, { method: 'POST' });
    assert.strictEqual(noKey.status, 401);
    ok('rechaza lo que no es PDF aunque lo declare, más de 10 MB y sin API key');

    const attachment = { url: uploaded.body.url, mimeType: 'application/pdf', sizeBytes: uploaded.body.sizeBytes, fileName: 'oficio.pdf' };
    const fromCitizen = await emit(smChat, 'send_message', { messageType: 'file', content: 'Aquí va', attachment });
    assert.strictEqual(fromCitizen.success, true, JSON.stringify(fromCitizen));
    assert.strictEqual(fromCitizen.message.messageType, 'file');
    assert.strictEqual(fromCitizen.message.attachment.fileName, 'oficio.pdf');
    const notPdf = await emit(smChat, 'send_message', { messageType: 'file', attachment: { ...attachment, mimeType: 'text/html' } });
    assert.match(notPdf.error, /PDF/);
    ok('el ciudadano envía el PDF por el socket; otro tipo declarado se rechaza');

    const [fileMsg] = await Promise.all([
      once(smChat, 'new_message'),
      agentSays({ messageType: 'file', content: '', agentName: 'Mariana', agentAvatarUrl: FOTO, attachment })
    ]);
    assert.strictEqual(fileMsg.messageType, 'file');
    assert.strictEqual(fileMsg.attachment.url, attachment.url);
    assert.strictEqual(fileMsg.senderAvatarUrl, FOTO);
    ok('el PDF del agente llega a la app con su nombre y foto');

    console.log('\nTodas las pruebas de la puerta de tickets pasaron.');
  } finally {
    sockets.forEach((s) => s.close());
    server.kill();
    noSecret.kill();
    smOnly.kill();
    ticketsServer.close();
    smServer.close();
    await mongo.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
