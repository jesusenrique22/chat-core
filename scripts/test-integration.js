/**
 * Script de prueba completa de integración para chat-core y el Sistema de Tickets.
 * 
 * Uso:
 *   node scripts/test-integration.js
 *   node scripts/test-integration.js --url https://tu-app-chat.onrender.com
 */

require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const PORT = process.env.PORT || 4001;
const args = process.argv.slice(2);
let targetUrl = process.env.CHAT_CORE_URL || `http://localhost:${PORT}`;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    targetUrl = args[i + 1];
  }
}

// Remover slash final si existe
targetUrl = targetUrl.replace(/\/$/, '');

const MARACAIBO_KEY = process.env.MARACAIBO_API_KEY || 'maracaibo_secret_key_2026';
const TICKETS_KEY = process.env.TICKETS_API_KEY || 'tickets_secret_key_2026';
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_API_URL || 'https://ticketsotravez-1.onrender.com/notifications/ticket';

const TICKET_ID = `TICKET-TEST-${Math.floor(1000 + Math.random() * 9000)}`;
const CUSTOMER_ID = `user_test_${Math.floor(100 + Math.random() * 900)}`;

console.log('\n======================================================');
console.log('🧪 SUITE DE PRUEBAS DE INTEGRACIÓN: CHAT-CORE & TICKETS');
console.log('======================================================');
console.log(`📍 Servidor Chat Target : ${targetUrl}`);
console.log(`🎫 Ticket de prueba    : ${TICKET_ID}`);
console.log(`👤 Cliente de prueba   : ${CUSTOMER_ID}`);
console.log(`🔔 Webhook Notif.     : ${NOTIFICATIONS_URL}`);
console.log('======================================================\n');

let passCount = 0;
let failCount = 0;

function logPass(msg, details = null) {
  passCount++;
  console.log(`✅ [PASS] ${msg}`);
  if (details) console.log(`   👉 Details:`, JSON.stringify(details));
}

function logFail(msg, error = null) {
  failCount++;
  console.error(`❌ [FAIL] ${msg}`);
  if (error) console.error(`   👉 Error:`, error);
}

async function runTests() {
  // PRUEBA 1: Health Check
  try {
    console.log('--- 1. Verificando Health Check ---');
    const res = await fetch(`${targetUrl}/health`);
    const data = await res.json();
    if (res.ok && data.ok) {
      logPass('Servidor chat-core está vivo y respondiendo', {
        status: data.status,
        service: data.service,
        notificationsWebhook: data.notificationsWebhook
      });
    } else {
      logFail(`Health check devolvió estatus ${res.status}`, data);
    }
  } catch (err) {
    logFail('No se pudo conectar al servidor chat-core. ¿Está encendido?', err.message);
    console.log('\n💡 Sugerencia: En otra terminal ejecuta: npm run backend');
    process.exit(1);
  }

  // PRUEBA 2: Enlazar Ticket
  try {
    console.log('\n--- 2. Enlazando Ticket con Conversación de Chat ---');
    const res = await fetch(`${targetUrl}/api/integrations/conversations/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MARACAIBO_KEY
      },
      body: JSON.stringify({
        ticketId: TICKET_ID,
        customerId: CUSTOMER_ID,
        customerName: 'Juan Pérez (Prueba)',
        sourceChannel: 'maracaibo_app',
        metadata: { tramite: 'Reclamo', entorno: 'Test-Script' }
      })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      logPass('Conversación enlazada exitosamente', {
        conversationId: data.conversationId,
        ticketId: data.ticketId
      });
    } else {
      logFail('Error al enlazar conversación', data);
    }
  } catch (err) {
    logFail('Fallo la petición de enlace', err.message);
  }

  // PRUEBA 3: Enviar mensaje desde Sistema de Tickets -> Cliente
  try {
    console.log('\n--- 3. Enviando Mensaje desde Sistema de Tickets -> Cliente ---');
    const res = await fetch(`${targetUrl}/api/integrations/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': TICKETS_KEY
      },
      body: JSON.stringify({
        ticketId: TICKET_ID,
        content: `Hola Juan, estamos procesando tu ticket ${TICKET_ID}.`,
        agentName: 'Soporte Maracaibo (Test Agent)'
      })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      logPass('Mensaje del Agente enviado correctamente', {
        messageId: data.message._id,
        content: data.message.content
      });
    } else {
      logFail('Error al enviar mensaje del Agente', data);
    }
  } catch (err) {
    logFail('Fallo la petición de envío de mensaje del agente', err.message);
  }

  // PRUEBA 4: Enviar mensaje del Cliente -> Sistema de Tickets
  try {
    console.log('\n--- 4. Enviando Respuesta del Cliente -> Sistema de Tickets ---');
    const res = await fetch(`${targetUrl}/api/integrations/messages/customer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MARACAIBO_KEY
      },
      body: JSON.stringify({
        ticketId: TICKET_ID,
        customerId: CUSTOMER_ID,
        content: 'Muchas gracias, quedo atento a la solución.'
      })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      logPass('Mensaje del Cliente enviado correctamente', {
        messageId: data.message._id,
        content: data.message.content
      });
    } else {
      logFail('Error al enviar mensaje del Cliente', data);
    }
  } catch (err) {
    logFail('Fallo la petición de envío de mensaje del cliente', err.message);
  }

  // PRUEBA 5: Consultar Historial de Mensajes del Ticket
  try {
    console.log('\n--- 5. Consultando Historial del Ticket ---');
    const res = await fetch(`${targetUrl}/api/integrations/conversations/${TICKET_ID}/messages`, {
      headers: {
        'X-Api-Key': TICKETS_KEY
      }
    });
    const data = await res.json();
    if (res.ok && Array.isArray(data.messages)) {
      logPass(`Historial recuperado con éxito: ${data.messages.length} mensajes guardados`, {
        mensajes: data.messages.map((m) => `${m.senderName || m.senderRole}: ${m.content}`)
      });
    } else {
      logFail('Error al consultar historial', data);
    }
  } catch (err) {
    logFail('Fallo al consultar historial', err.message);
  }

  // PRUEBA 6: Marcar Mensajes como Leídos (Webhook a Sistema de Tickets)
  try {
    console.log('\n--- 6. Marcando Mensajes como Leídos (Prueba de Webhook a Tickets) ---');
    const res = await fetch(`${targetUrl}/api/integrations/conversations/${TICKET_ID}/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MARACAIBO_KEY
      },
      body: JSON.stringify({
        readByRole: 'customer'
      })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      logPass('Confirmación de lectura procesada (Webhook emitido a Tickets)', {
        updatedCount: data.updatedCount
      });
    } else {
      logFail('Error al marcar mensajes como leídos', data);
    }
  } catch (err) {
    logFail('Fallo al marcar lectura', err.message);
  }

  // PRUEBA 7: Conectividad con Endpoint de Notificaciones de Tickets
  try {
    console.log('\n--- 7. Verificando Conectividad Directa con Sistema de Tickets (Webhook) ---');
    const res = await fetch(NOTIFICATIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': TICKETS_KEY
      },
      body: JSON.stringify({
        ticketId: TICKET_ID,
        type: 'ping_test',
        message: 'Prueba de conectividad desde script de chat-core'
      })
    });
    if (res.ok || res.status === 400 || res.status === 404 || res.status === 200) {
      logPass(`Sistema de Tickets alcanzó respuesta HTTP ${res.status}`, {
        url: NOTIFICATIONS_URL
      });
    } else {
      logFail(`Sistema de Tickets devolvió estatus de error ${res.status}`, await res.text());
    }
  } catch (err) {
    logFail(`No se pudo conectar a NOTIFICATIONS_API_URL (${NOTIFICATIONS_URL})`, err.message);
  }

  // RESUMEN FINAL
  console.log('\n======================================================');
  console.log('📊 RESUMEN FINAL DE PRUEBAS DE INTEGRACIÓN');
  console.log('======================================================');
  console.log(`✅ Pruebas Exitosas: ${passCount}`);
  console.log(`❌ Pruebas Fallidas : ${failCount}`);
  console.log('======================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
