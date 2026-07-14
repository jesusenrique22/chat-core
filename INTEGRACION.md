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
  content: "Hola 👋"
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
