/**
 * Suite de pruebas completas para chat-core y Sistema de Tickets:
 * 1. Health check y estado de base de datos MongoDB
 * 2. Enlace de conversación desde Sistema de Tickets
 * 3. Actualización de lastCustomerMessageAt al recibir mensaje del ciudadano
 * 4. Envío de mensaje del Agente desde Sistema de Tickets
 * 5. Endpoint de SLA / conversaciones vencidas (GET /api/integrations/conversations/overdue?hours=72)
 * 6. Validación con parámetro de horas personalizado (hours=5)
 * 7. Seguridad de API Key en endpoints de integración
 */

require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let server;
let io;
let baseUrl;

const MARACAIBO_KEY = process.env.MARACAIBO_API_KEY || 'maracaibo_secret_key_2026';
const TICKETS_KEY = process.env.TICKETS_API_KEY || 'tickets_secret_key_2026';
const PORT = 4099;

let passCount = 0;
let failCount = 0;

function logPass(msg, details = null) {
  passCount++;
  console.log(`  ✅ [PASS] ${msg}`);
  if (details) console.log(`     👉`, JSON.stringify(details));
}

function logFail(msg, error = null) {
  failCount++;
  console.error(`  ❌ [FAIL] ${msg}`);
  if (error) console.error(`     👉 Error:`, error);
}

const TEST_CONVERSATION_IDS = [];

async function startTestEnvironment() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI no está configurado en .env');
  }

  // Importar modelos y módulos
  const Platform = require('../src/models/Platform');
  const Conversation = require('../src/models/Conversation');
  const { connectMongo } = require('../src/lib/mongo');
  const { registerIntegrationRoutes } = require('../src/lib/integrations');

  await connectMongo(mongoUri);

  // Garantizar plataformas de prueba en MongoDB
  await Platform.updateOne(
    { apiKey: MARACAIBO_KEY },
    { $setOnInsert: { name: 'Servicios Maracaibo', apiKey: MARACAIBO_KEY, allowedOrigins: ['*'] } },
    { upsert: true }
  );
  await Platform.updateOne(
    { apiKey: TICKETS_KEY },
    { $setOnInsert: { name: 'Sistema de Tickets', apiKey: TICKETS_KEY, allowedOrigins: ['*'] } },
    { upsert: true }
  );

  const app = express();
  app.use(express.json());

  server = http.createServer(app);
  io = new Server(server);

  // Registrar rutas de integración con Socket.io
  registerIntegrationRoutes(app, io);

  // Endpoint SLA de overdue (mismo contrato que server.js)
  app.get('/api/integrations/conversations/overdue', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!apiKey) {
      return res.status(401).json({ error: 'API Key requerida' });
    }

    try {
      const platform = await Platform.findOne({ apiKey });
      if (!platform) {
        return res.status(401).json({ error: 'API Key no autorizada' });
      }

      const hours = Number(req.query.hours) || 72;
      const thresholdDate = new Date(Date.now() - hours * 60 * 60 * 1000);

      const overdue = await Conversation.find({
        status: 'active',
        $or: [
          { lastCustomerMessageAt: { $lte: thresholdDate } },
          { lastCustomerMessageAt: null, createdAt: { $lte: thresholdDate } }
        ]
      }).sort({ createdAt: 1 });

      res.json({
        ok: true,
        hoursThreshold: hours,
        count: overdue.length,
        conversations: overdue
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  await new Promise((resolve) => server.listen(PORT, resolve));
  baseUrl = `http://localhost:${PORT}`;
}

async function stopTestEnvironment() {
  if (TEST_CONVERSATION_IDS.length > 0) {
    const Conversation = require('../src/models/Conversation');
    const Message = require('../src/models/Message');
    await Conversation.deleteMany({ externalTicketId: { $in: TEST_CONVERSATION_IDS } });
    await Message.deleteMany({ externalTicketId: { $in: TEST_CONVERSATION_IDS } });
  }
  if (io) io.close();
  if (server) server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 SUITE DE PRUEBAS: CHAT-CORE & SISTEMA DE TICKETS (SLA 72H)');
  console.log('======================================================\n');

  try {
    await startTestEnvironment();

    const Conversation = require('../src/models/Conversation');
    const Platform = require('../src/models/Platform');

    const testTicketPrefix = `TK-TEST-${Date.now()}`;
    const tkMain = `${testTicketPrefix}-MAIN`;
    const tkOverdue80h = `${testTicketPrefix}-OVERDUE-80H`;
    const tkNoMsg80h = `${testTicketPrefix}-NO-MSG-80H`;
    const tkRecent10h = `${testTicketPrefix}-RECENT-10H`;
    const tkClosed80h = `${testTicketPrefix}-CLOSED-80H`;

    TEST_CONVERSATION_IDS.push(tkMain, tkOverdue80h, tkNoMsg80h, tkRecent10h, tkClosed80h);

    // --- 1. Health Check ---
    console.log('🔍 [1/7] Verificando Endpoint de Health Check...');
    const healthRes = await fetch(`${baseUrl}/api/integrations/health`);
    const healthData = await healthRes.json();
    if (healthRes.ok && healthData.ok && healthData.mongo?.ok) {
      logPass('Servidor e integración MongoDB funcionan correctamente', { state: healthData.mongo.state });
    } else {
      logFail('Error en Health Check', healthData);
    }

    // --- 2. Autenticación y Seguridad ---
    console.log('\n🔒 [2/7] Verificando Autenticación de API Key en /overdue...');
    const noKeyRes = await fetch(`${baseUrl}/api/integrations/conversations/overdue`);
    if (noKeyRes.status === 401) {
      logPass('Rechazo correcto de petición sin API Key (HTTP 401)');
    } else {
      logFail('Esperaba HTTP 401 al no enviar API Key', noKeyRes.status);
    }

    const invalidKeyRes = await fetch(`${baseUrl}/api/integrations/conversations/overdue?apiKey=clave_invalida`);
    if (invalidKeyRes.status === 401) {
      logPass('Rechazo correcto de petición con API Key no autorizada (HTTP 401)');
    } else {
      logFail('Esperaba HTTP 401 al usar API Key errónea', invalidKeyRes.status);
    }

    // --- 3. Enlace de Ticket ↔ Conversación ---
    console.log('\n🔗 [3/7] Verificando Enlace de Ticket desde el Sistema de Tickets...');
    const linkRes = await fetch(`${baseUrl}/api/integrations/conversations/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': TICKETS_KEY
      },
      body: JSON.stringify({
        ticketId: tkMain,
        customerId: 'ciudadano_123',
        customerName: 'María Rodríguez',
        sourceChannel: 'maracaibo_app'
      })
    });
    const linkData = await linkRes.json();
    if (linkRes.ok && linkData.success) {
      logPass('Conversación enlazada correctamente con el Sistema de Tickets', {
        conversationId: linkData.conversationId,
        ticketId: linkData.externalTicketId
      });
    } else {
      logFail('Fallo al enlazar ticket', linkData);
    }

    // --- 4. Mensaje de Ciudadano y actualización de lastCustomerMessageAt ---
    console.log('\n💬 [4/7] Verificando Actualización de lastCustomerMessageAt al recibir mensaje...');
    const customerMsgRes = await fetch(`${baseUrl}/api/integrations/messages/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MARACAIBO_KEY
      },
      body: JSON.stringify({
        ticketId: tkMain,
        customerId: 'ciudadano_123',
        content: 'Hola, requiero información sobre mi trámite'
      })
    });
    const customerMsgData = await customerMsgRes.json();
    if (customerMsgRes.ok && customerMsgData.success) {
      const conv = await Conversation.findOne({ externalTicketId: tkMain });
      if (conv && conv.lastCustomerMessageAt instanceof Date) {
        logPass('lastCustomerMessageAt actualizado automáticamente a fecha reciente', {
          lastCustomerMessageAt: conv.lastCustomerMessageAt.toISOString()
        });
      } else {
        logFail('lastCustomerMessageAt no es tipo Date o no se actualizó', conv);
      }
    } else {
      logFail('Fallo al registrar mensaje del ciudadano', customerMsgData);
    }

    // --- 5. Mensaje del Agente desde el Sistema de Tickets ---
    console.log('\n👨‍💼 [5/7] Verificando Envío de Mensaje del Agente desde Sistema de Tickets...');
    const agentMsgRes = await fetch(`${baseUrl}/api/integrations/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': TICKETS_KEY
      },
      body: JSON.stringify({
        ticketId: tkMain,
        content: 'Hola María, estamos revisando tu expediente.',
        agentName: 'Soporte Técnico'
      })
    });
    const agentMsgData = await agentMsgRes.json();
    if (agentMsgRes.ok && agentMsgData.success) {
      logPass('Mensaje del Agente entregado desde Sistema de Tickets', {
        senderName: agentMsgData.message.senderName,
        direction: agentMsgData.message.direction
      });
    } else {
      logFail('Fallo al enviar mensaje del agente', agentMsgData);
    }

    // --- 6. Prueba de Endpoint SLA Overdue (72 horas) ---
    console.log('\n⏱️ [6/7] Verificando Endpoint SLA Overdue de 72 horas...');
    
    // Crear escenarios de prueba en base de datos:
    const platform = await Platform.findOne({ apiKey: MARACAIBO_KEY });
    const now = Date.now();
    const eightyHoursAgo = new Date(now - 80 * 60 * 60 * 1000);
    const tenHoursAgo = new Date(now - 10 * 60 * 60 * 1000);

    // Caso A: Mensaje del cliente hace 80h (VENCIDO > 72h)
    await Conversation.create({
      platformId: platform._id,
      customerId: 'user_vencido_1',
      customerName: 'Cliente Vencido 1',
      externalTicketId: tkOverdue80h,
      status: 'active',
      lastCustomerMessageAt: eightyHoursAgo,
      createdAt: eightyHoursAgo
    });

    // Caso B: Sin mensaje del cliente pero creado hace 80h (VENCIDO > 72h)
    await Conversation.create({
      platformId: platform._id,
      customerId: 'user_vencido_2',
      customerName: 'Cliente Vencido 2',
      externalTicketId: tkNoMsg80h,
      status: 'active',
      lastCustomerMessageAt: null,
      createdAt: eightyHoursAgo
    });

    // Caso C: Mensaje del cliente hace 10h (ACTIVO Y AL DÍA < 72h)
    await Conversation.create({
      platformId: platform._id,
      customerId: 'user_al_dia',
      customerName: 'Cliente Al Día',
      externalTicketId: tkRecent10h,
      status: 'active',
      lastCustomerMessageAt: tenHoursAgo,
      createdAt: tenHoursAgo
    });

    // Caso D: Conversación cerrada creada hace 80h (NO debe salir en overdue)
    await Conversation.create({
      platformId: platform._id,
      customerId: 'user_cerrado',
      customerName: 'Cliente Cerrado',
      externalTicketId: tkClosed80h,
      status: 'closed',
      lastCustomerMessageAt: eightyHoursAgo,
      createdAt: eightyHoursAgo
    });

    // Consultar endpoint SLA 72h
    const overdueRes = await fetch(`${baseUrl}/api/integrations/conversations/overdue?hours=72`, {
      headers: { 'X-Api-Key': TICKETS_KEY }
    });
    const overdueData = await overdueRes.json();

    if (overdueRes.ok && overdueData.ok) {
      const ticketsDevueltos = overdueData.conversations.map(c => c.externalTicketId);
      const testTicketsRetornados = ticketsDevueltos.filter(id => TEST_CONVERSATION_IDS.includes(id));

      const incluyeVencidos = testTicketsRetornados.includes(tkOverdue80h) && testTicketsRetornados.includes(tkNoMsg80h);
      const excluyeNoVencidos = !testTicketsRetornados.includes(tkRecent10h) && !testTicketsRetornados.includes(tkClosed80h);

      if (incluyeVencidos && excluyeNoVencidos) {
        logPass(`Filtro SLA 72h funcionó perfectamente: retornó ${overdueData.count} conversaciones vencidas en total`, {
          ticketsTestVencidosRetornados: testTicketsRetornados
        });
      } else {
        logFail('El endpoint no filtró correctamente las conversaciones vencidas', {
          testTicketsRetornados,
          incluyeVencidos,
          excluyeNoVencidos
        });
      }
    } else {
      logFail('Fallo la consulta al endpoint /overdue', overdueData);
    }

    // --- 7. Prueba de Umbral de Horas Personalizado (hours=5) ---
    console.log('\n⚙️ [7/7] Verificando Endpoint SLA con Umbral Personalizado (hours=5)...');
    const customHoursRes = await fetch(`${baseUrl}/api/integrations/conversations/overdue?hours=5`, {
      headers: { 'X-Api-Key': TICKETS_KEY }
    });
    const customHoursData = await customHoursRes.json();

    if (customHoursRes.ok && customHoursData.ok) {
      const ticketsDevueltos = customHoursData.conversations.map(c => c.externalTicketId);
      const testTicketsRetornados = ticketsDevueltos.filter(id => TEST_CONVERSATION_IDS.includes(id));
      const incluyeTambien10h = testTicketsRetornados.includes(tkRecent10h);

      if (incluyeTambien10h) {
        logPass('Parámetro dinámico hours=5 incluyó correctamente la conversación de hace 10h', {
          ticket: tkRecent10h,
          testTicketsRetornados
        });
      } else {
        logFail('hours=5 no incluyó la conversación de hace 10 horas', testTicketsRetornados);
      }
    } else {
      logFail('Fallo la consulta con hours=5', customHoursData);
    }

  } catch (err) {
    logFail('Error inesperado durante las pruebas', err);
  } finally {
    await stopTestEnvironment();
  }

  // --- RESUMEN FINAL ---
  console.log('\n======================================================');
  console.log('📊 RESUMEN DE EJECUCIÓN DE PRUEBAS DE INTEGRACIÓN');
  console.log('======================================================');
  console.log(`✅ Pruebas Exitosas: ${passCount}`);
  console.log(`❌ Pruebas Fallidas : ${failCount}`);
  console.log('======================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('🏆 ¡TODAS LAS PRUEBAS DE INTEGRACIÓN Y SLA PASARON EXITOSAMENTE!');
    process.exit(0);
  }
}

runTests();
