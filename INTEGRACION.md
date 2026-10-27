# Integración: Conector Chat (Maracaibo ↔ Sistema de Tickets)

Este proyecto actúa como **conector central**: valida peticiones de **Servicios Maracaibo** (app/web) y del **Sistema de Tickets**, enlaza cada ticket con un chat y entrega mensajes en tiempo real.

**Servidor (red local):** `http://TU_IP_LAN:4000` — al arrancar `npm run backend` la consola muestra la IP para compartir.

---

## API Keys (desarrollo)

| Plataforma | Header `X-Api-Key` |
|------------|-------------------|
| Servicios Maracaibo | `maracaibo_secret_key_2026` |
| Sistema de Tickets | `tickets_secret_key_2026` |

---

## CORS

Este repo es **solo API** (sin HTML ni widget). Configura orígenes en `.env`:

```env
CORS_ALLOW_LAN=false
CORS_ALLOW_ALL=false
CORS_EXTRA_ORIGINS=https://app.tudominio.com,https://tickets.tudominio.com
```

Health: `GET /api/integrations/health`

---

## Flujo completo

```
1. Usuario en App → Centro de Ayuda → backend Maracaibo crea ticket (en su servidor)
2. Backend Maracaibo → POST /api/integrations/conversations/link  (ticketId + userId)
3. App abre chat → Socket /client con ticketId en auth
4. Agente en Sistema de Tickets responde → POST /api/integrations/messages
5. Conector → Socket new_message → App del ciudadano
```

---

## Endpoints REST

### Health

```bash
curl http://localhost:4000/api/integrations/health
```

Respuesta (campos originales + aditivos). Si Mongo falla → HTTP `503` y `"ok": false`.

```json
{
  "ok": true,
  "service": "chat-multiservicio-connector",
  "version": "1.0.0",
  "uptimeSec": 120,
  "startedAt": "2026-07-14T16:00:00.000Z",
  "mongo": { "ok": true, "state": "connected" },
  "timestamp": "2026-07-14T16:02:00.000Z"
}
```

### 1. Enlazar ticket con conversación de chat

**Quién:** Backend Maracaibo (después de crear el ticket) o Tickets.

```bash
curl -X POST http://localhost:4000/api/integrations/conversations/link \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: maracaibo_secret_key_2026" \
  -d '{
    "ticketId": "TEST-001",
    "customerId": "user_test_001",
    "customerName": "Juan Pérez",
    "sourceChannel": "maracaibo_app",
    "metadata": { "tramite": "Licencia", "cedula": "V-12345678" }
  }'
```

### 2. Agente en Sistema de Tickets → mensaje al ciudadano (Maracaibo)

**Quién:** Solo API Key de **Sistema de Tickets**.

```bash
curl -X POST http://localhost:4000/api/integrations/messages \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: tickets_secret_key_2026" \
  -d '{
    "ticketId": "TEST-001",
    "content": "Hola, estamos revisando su caso.",
    "agentName": "María López"
  }'
```

El mensaje llega en tiempo real a quien tenga abierto el chat con el mismo `ticketId` / `customerId`.

### 3. Ciudadano → mensaje por REST (opcional, además del socket)

```bash
curl -X POST http://localhost:4000/api/integrations/messages/inbound \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: maracaibo_secret_key_2026" \
  -d '{
    "ticketId": "TEST-001",
    "customerId": "user_test_001",
    "content": "Adjunto el comprobante, gracias."
  }'
```

### 4. Historial por ticket (para UI del sistema de tickets)

Incluye conversaciones **activas y cerradas**. Respuesta estructurada con estadísticas y trazabilidad.

```bash
curl "http://localhost:4000/api/integrations/history/ticket/TEST-001" \
  -H "X-Api-Key: tickets_secret_key_2026"
```

Filtros opcionales: `?senderType=customer&messageType=image&limit=100`

Cada mensaje incluye: `deliveryChannel`, `direction`, `externalTicketId`, `customerId`, `messageType`, `attachment`.

**Dashboard interno:** `GET /api/conversations/{conversationId}/history` (misma estructura).

---

## Socket.io (App / Web Maracaibo)

**URL:** `http://localhost:4000/client`

**Auth al conectar:**

```javascript
{
  apiKey: "maracaibo_secret_key_2026",
  customerId: "user_test_001",
  customerName: "Juan Pérez",
  ticketId: "TEST-001"   // importante: mismo ID del ticket
}
```

**Eventos:** `join_chat`, `send_message`, `client_typing`, `mark_messages_read`, `load_older_messages` (Socket; sin cambiar REST).

**Mensaje de texto:**

```javascript
socket.emit("send_message", {
  messageType: "text",
  content: "Hola"
});
```

**Mensaje con imagen** (subir primero, luego enviar URL):

```javascript
// 1) Subir imagen
const form = new FormData();
form.append("image", fileInput.files[0]);
const up = await fetch("http://TU_IP:4000/api/uploads/image", {
  method: "POST",
  headers: { "X-Api-Key": "maracaibo_secret_key_2026" },
  body: form
}).then(r => r.json());

// 2) Enviar mensaje
socket.emit("send_message", {
  messageType: "image",
  content: "Caption opcional",
  attachment: {
    url: up.url,
    mimeType: up.mimeType,
    sizeBytes: up.sizeBytes,
    fileName: up.fileName
  }
});
```

---

## Subida de imágenes (REST)

Las imágenes se suben al **bucket** (`folder=ticket_chat` vía `api-bucket.smart.com.ve`). El conector hace de proxy; MongoDB solo guarda la URL pública.

```bash
curl -X POST http://localhost:4000/api/uploads/image \
  -H "X-Api-Key: maracaibo_secret_key_2026" \
  -F "image=@/ruta/foto.jpg"
```

Respuesta:

```json
{
  "success": true,
  "url": "https://bucket.smart.com.ve/imau/ticket_chat/....jpg",
  "key": "ticket_chat/....jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 84200,
  "fileName": "foto.jpg"
}
```

- Formatos: JPG, PNG, WEBP, GIF
- Tamaño máximo: 3 MB (`UPLOAD_MAX_BYTES` en `.env`)
- Variables: `BUCKET_UPLOAD_URL`, `BUCKET_API_KEY`, `BUCKET_FOLDER=ticket_chat`
- Ya no se usa el directorio local `/uploads` del droplet

**Parámetros de imagen (ciudadano y agente):**

| Regla | Valor |
|-------|--------|
| Formatos | JPG, PNG, WEBP, GIF |
| Tamaño máximo | 3 MB |
| Campo multipart | `image` |
| Header upload | `X-Api-Key: maracaibo_secret_key_2026` (ciudadano) o `tickets_secret_key_2026` (agente/tickets) |

**Enviar imagen desde Tickets (REST):**

```bash
curl -X POST http://localhost:4000/api/integrations/messages \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: tickets_secret_key_2026" \
  -d '{
    "ticketId": "TEST-001",
    "messageType": "image",
    "content": "Aquí está el comprobante",
    "attachment": {
      "url": "https://bucket.smart.com.ve/imau/ticket_chat/abc-uuid.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 84200,
      "fileName": "comprobante.jpg"
    },
    "agentName": "María López"
  }'
```

---

## Notas de voz (REST + Socket)

Mismo flujo que las imágenes: primero se sube el audio, luego se envía el mensaje con la URL.
Sin límite de duración; tope de **25 MB** por archivo (`UPLOAD_MAX_AUDIO_BYTES`).

**1) Subir** (`multipart/form-data`, campo `audio`). Formatos: M4A/AAC (recomendado, `audio/mp4`),
WebM/OGG (Opus), MP3, WAV. El tipo se valida por la firma del archivo.

```bash
curl -X POST http://localhost:4000/api/uploads/audio \
  -H "X-Api-Key: maracaibo_secret_key_2026" \
  -F "audio=@nota.m4a"
# → 201 { "success": true, "url": "https://...m4a", "mimeType": "audio/mp4", "sizeBytes": 123456, "fileName": "nota.m4a" }
```

**2) Enviar** el mensaje (`messageType: "audio"`):

```javascript
socket.emit("send_message", {
  messageType: "audio",
  content: "",
  attachment: { url, mimeType: "audio/mp4", sizeBytes, durationMs: 15300 }
});
```

Por REST (sistema de tickets → ciudadano): `POST /api/integrations/messages` con el mismo
`messageType` y `attachment`. Los mensajes llegan con `messageType: "audio"` y
`attachment.durationMs`; la vista previa de la conversación es `Nota de voz`.

Pruebas: `node scripts/test-audio.js`.

## Integración en Sistema de Tickets

Cuando el agente envía un mensaje en la UI del ticket:

```javascript
await fetch('http://localhost:4000/api/integrations/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': 'tickets_secret_key_2026'
  },
  body: JSON.stringify({
    ticketId: ticket.id,
    content: mensajeDelAgente,
    agentName: agente.nombre
  })
});
```

---

## Monitoreo vía API / Socket `/agent`

Este repo ya **no incluye** el dashboard Next.js. Para listar conversaciones o escuchar en tiempo real:

```bash
curl "http://localhost:4000/api/conversations"
```

Socket namespace `/agent` (sin auth de agente).

---

## Script de prueba automática

```bash
pnpm run test:connector
# o: npm run test:connector
```

(Requiere backend en marcha en el puerto 4000.)

---

## Llamadas de voz (WebRTC)

El audio viaja directo entre el panel y la app (o por TURN de Cloudflare); chat-core solo hace la
señalización por los mismos sockets del chat. Solo el **Sistema de Tickets** puede iniciar una llamada
(valida que quien llama sea el funcionario a cargo del caso).

```
Tickets ── POST /api/integrations/calls {ticketId, agentName, agentId, systemName} ──► { callId, agentToken, iceServers }
Panel   ── /agent  call_join {callId, token} ───────────────────────────► App: call_incoming
App     ── /client call_accept {callId} → ack { success, iceServers } ──► Panel: call_accepted
Panel   ── call_signal {callId, data:{type:'offer', sdp}} ──────────────► App: call_signal
App     ── call_signal {callId, data:{type:'answer', sdp}} ─────────────► Panel: call_signal
Ambos   ── call_signal {callId, data:{type:'candidate', candidate}} ────► el otro
Cualquiera ── call_end {callId} ────────────────────────────────────────► ambos: call_ended
```

**Eventos que recibe la app (`/client`):**

| Evento | Payload | Qué hacer |
|---|---|---|
| `call_incoming` | `{ callId, callerName, ticketId, conversationId, ringTimeoutMs }` | Mostrar llamada entrante. También llega al conectar si ya estaba sonando. |
| `call_answered_elsewhere` | `{ callId }` | Dejar de sonar (contestó en otro dispositivo). |
| `call_signal` | `{ callId, data }` | `offer` → `setRemoteDescription` + `createAnswer` + enviar `answer`. `candidate` → `addIceCandidate` (encolar si aún no hay remoteDescription). |
| `call_peer_disconnected` | `{ callId }` | Mostrar "reconectando…" (el audio puede seguir). |
| `call_ended` | `{ callId, status, reason, durationMs }` | Cerrar la pantalla. `status`: `ended`, `missed`, `rejected`, `cancelled`. |

**Eventos que emite la app (todos con ack):** `call_accept`, `call_reject`, `call_end`, `call_signal`
(sin ack) y `call_resume {callId}` tras reconectar el socket en plena llamada.

La llamada suena 45 s; si nadie contesta queda `missed`. Al terminar, chat-core deja en el chat
"Llamada de voz m:ss", "Llamada perdida" o "Llamada rechazada" (texto plano, sin emojis).

Referencia funcional del lado ciudadano: `scripts/llamada-ciudadano.html`.
Pruebas: `node scripts/test-calls.js` (MongoDB en memoria).

### Push de llamadas (app cerrada)

Cada vez que empieza a sonar una llamada, chat-core avisa al backend de Servicios Maracaibo para que
mande la notificación push (CallKit / FCM). Se envía **siempre**, aunque haya socket conectado: en
Android la app mantiene el socket en segundo plano y ese `call_incoming` no muestra pantalla (la app
no muestra la llamada dos veces). El resultado queda en la llamada (`pushSent`, `pushEndSent`, `pushError`).

```
POST {CALLS_PUSH_URL}
x-internal-key: {CALLS_PUSH_KEY}
{ "type": "call", "cedula": "V9900000", "callId": "...", "callerName": "Mariana - Polimaracaibo",
  "ticketId": "<_id del ticket>", "caseNumber": "PM202610208" }
```

- `type: "call_end"` (mismo `callId`) cuando deja de sonar: contestada, perdida, rechazada o cancelada.
  Solo se envía si antes se envió `call`.
- Timeout de 3 s y sin reintentos: si el push falla, la llamada sigue igual.
- Al abrir la app desde la notificación, el socket recibe `call_incoming` al conectar y contesta con
  `call_accept` / `call_reject` como siempre.
