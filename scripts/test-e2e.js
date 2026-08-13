/**
 * Suite de Pruebas Automatizadas End-to-End para chat-core / chat-prueba
 * 
 * Ejecuta verificaciones completas de:
 * 1. Health Check & Estado de MongoDB
 * 2. Seguridad y autenticación de API Keys (401, 403, 200)
 * 3. Enlace de conversaciones / tickets (POST /api/integrations/conversations/link)
 * 4. Envío de mensajes vía REST (POST /api/integrations/messages)
 * 5. Lectura de historial de mensajes (GET /api/integrations/conversations/:ticketId/messages)
 * 6. Conexión y mensajería en tiempo real mediante WebSockets (Socket.io /client y /agent)
 * 7. Manejo de errores y validación de payloads
 */

require('dotenv').config();
const http = require('http');
const ioClient = require('socket.io-client');

const PORT = process.env.PORT || 4001;
const BASE_URL = `http://localhost:${PORT}`;

const MARACAIBO_KEY = 'maracaibo_secret_key_2026';
const TICKETS_KEY = 'tickets_secret_key_2026';
const TEST_TICKET_ID = `AUTO-TEST-${Date.now()}`;
const TEST_CUSTOMER_ID = `user_auto_${Date.now()}`;
const TEST_CUSTOMER_NAME = 'Cliente Automatizado';

const stats = {
  total: 0,
  passed: 0,
  failed: 0,
  details: []
};

function logResult(testName, passed, error = null) {
  stats.total++;
  if (passed) {
    stats.passed++;
    console.log(`  ✅ [PASS] ${testName}`);
    stats.details.push({ testName, status: 'PASS' });
  } else {
    stats.failed++;
    console.error(`  ❌ [FAIL] ${testName}${error ? ` → Error: ${error}` : ''}`);
    stats.details.push({ testName, status: 'FAIL', error: String(error) });
  }
}

function makeRequest(path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log(`\n======================================================`);
  console.log(`🚀 INICIANDO PRUEBAS AUTOMATIZADAS DE CHAT-CORE`);
  console.log(`📍 Servidor objetivo: ${BASE_URL}`);
  console.log(`🎫 Ticket ID de prueba: ${TEST_TICKET_ID}`);
  console.log(`======================================================\n`);

  // --- SECCIÓN 1: Health Check ---
  console.log(`🔍 [1/6] Verificando Health Check del Servidor & MongoDB...`);
  try {
    const health = await makeRequest('/api/integrations/health');
    const isOk = health.status === 200 && health.body.ok === true && health.body.mongo?.ok === true;
    logResult('Health Check (API responde OK y MongoDB está conectado)', isOk, !isOk ? JSON.stringify(health.body) : null);
  } catch (err) {
    logResult('Health Check (API responde OK y MongoDB está conectado)', false, err.message);
  }

  // --- SECCIÓN 2: Seguridad & Autenticación ---
  console.log(`\n🔒 [2/6] Verificando Seguridad & Autenticación (X-Api-Key)...`);
  
  // 2.1 Petición sin API Key
  try {
    const res = await makeRequest('/api/integrations/conversations/link', 'POST', {}, { ticketId: '123' });
    logResult('Rechazo de petición sin X-Api-Key (HTTP 401)', res.status === 401);
  } catch (err) {
    logResult('Rechazo de petición sin X-Api-Key (HTTP 401)', false, err.message);
  }

  // 2.2 Petición con API Key Inválida
  try {
    const res = await makeRequest('/api/integrations/conversations/link', 'POST', { 'X-Api-Key': 'clave_falsa_999' }, { ticketId: '123' });
    logResult('Rechazo de API Key inválida (HTTP 403)', res.status === 403);
  } catch (err) {
    logResult('Rechazo de API Key inválida (HTTP 403)', false, err.message);
  }

  // 2.3 Petición con API Key Válida (Maracaibo)
  try {
    const res = await makeRequest('/api/integrations/health', 'GET', { 'X-Api-Key': MARACAIBO_KEY });
    logResult('Aceptación de API Key válida Maracaibo (HTTP 200)', res.status === 200);
  } catch (err) {
    logResult('Aceptación de API Key válida Maracaibo (HTTP 200)', false, err.message);
  }

  // --- SECCIÓN 3: Enlace de Conversación / Ticket ---
  console.log(`\n🔗 [3/6] Verificando Enlace de Ticket ↔ Conversación...`);
  
  // 3.1 Error al faltar campos obligatorios
  try {
    const res = await makeRequest('/api/integrations/conversations/link', 'POST', { 'X-Api-Key': MARACAIBO_KEY }, { ticketId: TEST_TICKET_ID });
    logResult('Validación de campos requeridos al enlazar (HTTP 400)', res.status === 400);
  } catch (err) {
    logResult('Validación de campos requeridos al enlazar (HTTP 400)', false, err.message);
  }

  // 3.2 Enlace exitoso
  let conversationId = null;
  try {
    const payload = {
      ticketId: TEST_TICKET_ID,
      customerId: TEST_CUSTOMER_ID,
      customerName: TEST_CUSTOMER_NAME,
      sourceChannel: 'maracaibo_app',
      metadata: { tramite: 'Prueba Automatizada', cedula: 'V-00000000' }
    };
    const res = await makeRequest('/api/integrations/conversations/link', 'POST', { 'X-Api-Key': MARACAIBO_KEY }, payload);
    const passed = (res.status === 200 || res.status === 201) && (res.body.success === true || res.body.ok === true) && res.body.externalTicketId === TEST_TICKET_ID;
    conversationId = res.body.conversationId;
    logResult('Enlace exitoso de Ticket ↔ Conversación (HTTP 200/201)', passed, !passed ? JSON.stringify(res.body) : null);
  } catch (err) {
    logResult('Enlace exitoso de Ticket ↔ Conversación (HTTP 200/201)', false, err.message);
  }

  // --- SECCIÓN 4: Envío de Mensajes y Consulta de Historial ---
  console.log(`\n💬 [4/6] Verificando Envío de Mensajes REST e Historial...`);

  // 4.1 Enviar mensaje desde Sistema de Tickets
  try {
    const msgPayload = {
      ticketId: TEST_TICKET_ID,
      content: 'Mensaje automatizado desde el Sistema de Tickets',
      agentName: 'Agente Bot'
    };
    const res = await makeRequest('/api/integrations/messages', 'POST', { 'X-Api-Key': TICKETS_KEY }, msgPayload);
    const passed = (res.status === 200 || res.status === 201) && (res.body.success === true || res.body.ok === true) && res.body.message?.content === msgPayload.content;
    logResult('Envío de mensaje desde Sistema de Tickets vía REST (HTTP 200/201)', passed, !passed ? JSON.stringify(res.body) : null);
  } catch (err) {
    logResult('Envío de mensaje desde Sistema de Tickets vía REST (HTTP 200/201)', false, err.message);
  }

  // 4.2 Obtener Historial de Mensajes
  try {
    const res = await makeRequest(`/api/integrations/conversations/${TEST_TICKET_ID}/messages`, 'GET', { 'X-Api-Key': TICKETS_KEY });
    const passed = res.status === 200 && (res.body.success === true || res.body.ok === true) && Array.isArray(res.body.messages) && res.body.messages.length > 0;
    logResult('Obtención de historial de mensajes guardados en DB (HTTP 200)', passed, !passed ? JSON.stringify(res.body) : null);
  } catch (err) {
    logResult('Obtención de historial de mensajes guardados en DB (HTTP 200)', false, err.message);
  }

  // --- SECCIÓN 5: WebSockets en Tiempo Real ---
  console.log(`\n⚡ [5/6] Verificando WebSockets en Tiempo Real (Socket.io)...`);

  let clientSocket = null;
  let agentSocket = null;

  try {
    // Conectar socket /client (Ciudadano)
    clientSocket = ioClient(`${BASE_URL}/client`, {
      transports: ['websocket'],
      auth: {
        apiKey: MARACAIBO_KEY,
        ticketId: TEST_TICKET_ID,
        customerId: TEST_CUSTOMER_ID,
        customerName: TEST_CUSTOMER_NAME
      },
      timeout: 5000
    });

    const clientConnected = await new Promise((resolve) => {
      clientSocket.on('connect', () => resolve(true));
      clientSocket.on('connect_error', (err) => resolve(false));
      setTimeout(() => resolve(false), 4000);
    });

    logResult('Conexión de Socket Cliente (/client)', clientConnected);

    // Unir socket del cliente al chat
    let joinedChat = false;
    if (clientConnected) {
      joinedChat = await new Promise((resolve) => {
        clientSocket.emit('join_chat', (res) => {
          if (res && res.success) resolve(true);
          else resolve(false);
        });
        setTimeout(() => resolve(false), 4000);
      });
    }
    logResult('Unirse a la conversación vía Socket (join_chat)', joinedChat);

    // Conectar socket /agent (Panel de Agentes)
    agentSocket = ioClient(`${BASE_URL}/agent`, {
      transports: ['websocket'],
      timeout: 5000
    });

    const agentConnected = await new Promise((resolve) => {
      agentSocket.on('connect', () => resolve(true));
      agentSocket.on('connect_error', (err) => resolve(false));
      setTimeout(() => resolve(false), 4000);
    });

    logResult('Conexión de Socket Agente (/agent)', agentConnected);

    // Probar envío de mensaje en tiempo real del Cliente al Agente
    if (clientConnected && joinedChat && agentConnected) {
      const realTimeTestMessage = `Mensaje en tiempo real Socket.io ${Date.now()}`;
      
      const receivedByAgentPromise = new Promise((resolve) => {
        agentSocket.on('new_message', (data) => {
          if (data && (data.content === realTimeTestMessage || data.message?.content === realTimeTestMessage)) {
            resolve({ pass: true });
          }
        });
        setTimeout(() => resolve({ pass: false, reason: 'Timeout esperando new_message en socket agente' }), 4000);
      });

      const ackPromise = new Promise((resolve) => {
        clientSocket.emit('send_message', { content: realTimeTestMessage }, (ack) => {
          resolve(ack);
        });
        setTimeout(() => resolve({ success: false, error: 'Timeout en ack send_message' }), 4000);
      });

      const [ack, agentResult] = await Promise.all([ackPromise, receivedByAgentPromise]);
      const socketPass = ack.success === true && agentResult.pass === true;
      logResult(
        'Transmisión de mensaje en tiempo real Cliente ➔ Agente (Socket.io)',
        socketPass,
        !socketPass ? `ACK: ${JSON.stringify(ack)} | AgentResult: ${JSON.stringify(agentResult)}` : null
      );
    }
  } catch (err) {
    logResult('Pruebas de WebSocket en tiempo real', false, err.message);
  } finally {
    if (clientSocket) clientSocket.close();
    if (agentSocket) agentSocket.close();
  }

  // --- SECCIÓN 6: Resumen Final ---
  console.log(`\n======================================================`);
  console.log(`📊 RESUMEN DE EJECUCIÓN DE PRUEBAS`);
  console.log(`======================================================`);
  console.log(`Total de pruebas:  ${stats.total}`);
  console.log(`Pruebas exitosas:  ${stats.passed} ✅`);
  console.log(`Pruebas fallidas:  ${stats.failed} ${stats.failed > 0 ? '❌' : '🎉'}`);
  console.log(`======================================================\n`);

  if (stats.failed > 0) {
    console.error(`💥 SE DETECTARON FALLOS EN LAS PRUEBAS.`);
    process.exit(1);
  } else {
    console.log(`🏆 ¡TODAS LAS PRUEBAS PASARON CORRECTAMENTE SIN ERRORES!`);
    process.exit(0);
  }
}

// Permitir ejecutar directamente o ser importado
if (require.main === module) {
  runTests().catch((err) => {
    console.error('Fatal error running tests:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
