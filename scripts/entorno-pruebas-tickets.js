/**
 * Entorno de pruebas para el equipo de Servicios Maracaibo: chat-core + Sistema de Tickets reales,
 * con MongoDB en memoria. Los datos se borran al detenerlo, salvo los archivos, que van a una carpeta
 * de pruebas del bucket real. No envía push ni correos.
 *
 * Uso: node scripts/entorno-pruebas-tickets.js
 *      TICKETS_REPO=/ruta/al/repo-de-tickets node scripts/entorno-pruebas-tickets.js
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');

const CHAT_PORT = Number(process.env.CHAT_PORT) || 4001;
const TICKETS_PORT = Number(process.env.TICKETS_PORT) || 3001;
const TICKETS_REPO = process.env.TICKETS_REPO || path.resolve(__dirname, '../../ticketsotravez');

// Valores solo de prueba: no sirven en ningún entorno real.
const MARACAIBO_KEY = 'prueba_maracaibo_key';
const TICKETS_KEY = 'prueba_tickets_key';
const CITIZEN_SECRET = 'prueba_citizen_token_secret';
const AGENT_SECRET = 'prueba_agent_token_secret';
const PANEL_USER = 'prueba';
const PANEL_PASSWORD = 'Prueba12345';
const PANEL_AVATAR_URL = 'https://bucket.smart.com.ve/imau/ticket_chat/aa398a62-4b9f-427e-a49b-97aa1100c83b-avatar-angelina.png';
const TOKEN_TTL_SEC = 24 * 60 * 60;

function citizenToken(cedula, name) {
  const payload = Buffer.from(
    JSON.stringify({ sub: cedula, name, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC })
  ).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', CITIZEN_SECRET).update(payload).digest('hex')}`;
}

function lanIp() {
  const nets = Object.values(os.networkInterfaces()).flat();
  return nets.find((n) => n.family === 'IPv4' && !n.internal)?.address || '127.0.0.1';
}

async function waitFor(url, label) {
  for (let i = 0; i < 240; i += 1) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} no arrancó`);
}

/** La base de prueba nace vacía: sin este usuario nadie puede entrar al panel. */
async function createPanelUser(uri) {
  const bcrypt = require(path.join(TICKETS_REPO, 'node_modules/bcryptjs'));
  const client = await MongoClient.connect(uri);
  await client.db().collection('users').insertOne({
    name: 'Agente Prueba',
    username: PANEL_USER,
    email: 'agente.prueba@example.com',
    role: 'superadmin',
    avatar_url: PANEL_AVATAR_URL,
    password: await bcrypt.hash(PANEL_PASSWORD, 10),
    created_at: new Date().toISOString()
  });
  await client.close();
}

/** Con un puerto ocupado, un servidor anterior respondería por el nuevo y parecería que arrancó. */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(
      `El puerto ${port} ya está en uso. Cierra el entorno anterior con Ctrl+C en su terminal, o busca el proceso con: lsof -i :${port}`
    )));
    probe.listen(port, () => probe.close(resolve));
  });
}

async function main() {
  await assertPortFree(CHAT_PORT);
  await assertPortFree(TICKETS_PORT);
  const mongo = await MongoMemoryServer.create();
  await createPanelUser(mongo.getUri('tickets'));
  const chatUrl = `http://127.0.0.1:${CHAT_PORT}`;
  const ticketsUrl = `http://127.0.0.1:${TICKETS_PORT}`;

  const envFile = path.resolve(__dirname, '../.env');
  const bucket = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};

  const chat = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      CHAT_CORE_SKIP_DOTENV: 'true',
      PORT: String(CHAT_PORT),
      NODE_ENV: 'test',
      MONGODB_URI: mongo.getUri('chat'),
      REDIS_URL: '',
      CORS_ALLOW_LAN: 'false',
      CORS_ALLOW_ALL: 'true',
      // Imágenes y audios van al bucket real, en una carpeta aparte de los archivos de producción.
      BUCKET_UPLOAD_URL: bucket.BUCKET_UPLOAD_URL || 'http://127.0.0.1:9/sin-bucket',
      BUCKET_API_KEY: bucket.BUCKET_API_KEY || 'prueba',
      BUCKET_FOLDER: 'ticket_chat_pruebas',
      MARACAIBO_API_KEY: MARACAIBO_KEY,
      NOTIFICATIONS_API_KEY: TICKETS_KEY,
      NOTIFICATIONS_API_URL: `${ticketsUrl}/notifications/ticket`,
      TICKETS_API_URL: ticketsUrl,
      CITIZEN_TOKEN_SECRET: CITIZEN_SECRET,
      // Acepta también el accessToken real del login de SM; los datos siguen siendo los de prueba.
      SM_AUTH_ME_URL: process.env.SM_AUTH_ME_URL || 'https://api.serviciosmaracaibo.com/api/auth/me',
      // Como quedará al final de la migración: el socket también exige el token.
      CLIENT_TOKEN_SECRET: CITIZEN_SECRET,
      CALLS_PUSH_URL: '',
      AGENT_TOKEN_SECRET: AGENT_SECRET,
      LOG_LEVEL: 'warn',
      LOG_HTTP_REQUESTS: 'true'
    }
  });

  // Next da prioridad a estas variables sobre el .env del repo de tickets.
  const tickets = spawn('npx', ['next', 'dev', '-p', String(TICKETS_PORT)], {
    cwd: TICKETS_REPO,
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      MONGODB_URI: mongo.getUri('tickets'),
      MONGODB_DB: 'tickets',
      CHAT_CONNECTOR_URL: chatUrl,
      NEXT_PUBLIC_CHAT_URL: chatUrl,
      CHAT_API_KEY: TICKETS_KEY,
      CHAT_WEBHOOK_API_KEY: TICKETS_KEY,
      AGENT_TOKEN_SECRET: AGENT_SECRET,
      CHAT_USE_TUNNEL_ONLY: 'false',
      TICKETS_PUBLIC_URL: ticketsUrl,
      NEXT_PUBLIC_TICKETS_URL: ticketsUrl,
      PUSH_NOTIFICATION_URL: '',
      RESEND_API_KEY: '',
      SERVICIOS_MARACAIBO_API_KEY: '',
      SYNC_FROM_PRODUCTION_ON_START: 'false'
    }
  });

  let stopping = false;
  const stop = async (exitCode = 0) => {
    stopping = true;
    chat.kill();
    try {
      process.kill(-tickets.pid);
    } catch {
      /* ya terminó */
    }
    await mongo.stop();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());

  // Sin uno de los dos servidores, la app solo recibiría 502: mejor detener todo y decirlo.
  const stopIfDied = (label, hint) => () => {
    if (stopping) return;
    console.error(`\n${label} se detuvo, así que el entorno de pruebas también. ${hint}`);
    stop(1);
  };
  chat.on('exit', stopIfDied('chat-core', `Revisa que nada más use el puerto ${CHAT_PORT}.`));
  tickets.on(
    'exit',
    stopIfDied('El Sistema de Tickets', 'Cierra cualquier `pnpm run dev` abierto en ticketsotravez: Next no permite dos en la misma carpeta.')
  );

  await Promise.all([waitFor(`${chatUrl}/health`, 'chat-core'), waitFor(`${ticketsUrl}/notifications/ticket`, 'tickets')]);

  console.log(`
Entorno de pruebas listo (datos en memoria; Ctrl+C lo detiene y los borra).

  Misma red:             http://${lanIp()}:${CHAT_PORT}
  Otra red:              expón solo el puerto ${CHAT_PORT} con un túnel
  X-Api-Key:             ${MARACAIBO_KEY}
  CITIZEN_TOKEN_SECRET:  ${CITIZEN_SECRET}

  Token V-12345678 (24 h): ${citizenToken('V-12345678', 'Ciudadano Prueba')}
  Token V-87654321 (24 h): ${citizenToken('V-87654321', 'Otro Ciudadano')}

  Panel de tickets (solo tú): ${ticketsUrl.replace('127.0.0.1', 'localhost')} | usuario: ${PANEL_USER} | contraseña: ${PANEL_PASSWORD}

  Aquí verás cada petición: [HTTP] y [SOCKET] las recibe chat-core; las rutas /integrations/... las recibe tickets.

  Responder como agente (solo tú; no compartas esta key como si fuera de la app):
    curl -X POST ${chatUrl}/api/integrations/messages -H 'Content-Type: application/json' \\
      -H 'X-Api-Key: ${TICKETS_KEY}' \\
      -d '{"ticketId":"<_id>","content":"Hola, soy el agente","agentName":"Agente Prueba"}'
`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
