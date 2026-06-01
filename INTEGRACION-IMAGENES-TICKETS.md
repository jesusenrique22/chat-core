# Imágenes en chat — Guía para Sistema de Tickets

Documento para integrar **ver** y **enviar** imágenes desde la UI del sistema de tickets hacia el conector de chat.

---

## Datos de conexión

| Concepto | Valor (desarrollo) |
|----------|-------------------|
| **Base URL del conector** | `http://192.168.0.11:4000` ← usar la IP que muestra `npm run backend` |
| **API Key Tickets** | `tickets_secret_key_2026` |
| **Header en todas las peticiones** | `X-Api-Key: tickets_secret_key_2026` |

> ⚠️ No uses `localhost` en la UI del compañero. Las URLs de imagen deben ser accesibles en la red (`http://TU_IP:4000/uploads/...`).

---

## Reglas de imágenes

| Regla | Valor |
|-------|--------|
| Formatos permitidos | JPG, JPEG, PNG, WEBP, GIF |
| Tamaño máximo | **3 MB** (3 145 728 bytes) |
| Campo del archivo (multipart) | `image` |
| Texto opcional | caption en `content` (puede ir vacío `""`) |

---

## Flujo para enviar imagen (agente → ciudadano)

Siempre son **2 pasos**:

```
1. POST /api/uploads/image     → sube el archivo, devuelve url + metadatos
2. POST /api/integrations/messages   → envía el mensaje con messageType: "image"
```

### Paso 1 — Subir imagen

```http
POST http://192.168.0.11:4000/api/uploads/image
X-Api-Key: tickets_secret_key_2026
Content-Type: multipart/form-data

Campo: image = (archivo binario)
```

**Respuesta 201:**

```json
{
  "success": true,
  "url": "http://192.168.0.11:4000/uploads/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 84200,
  "fileName": "comprobante.jpg"
}
```

**Errores comunes:**

| HTTP | Causa |
|------|--------|
| 401 | Falta o API Key incorrecta |
| 400 | Archivo > 3 MB, formato no permitido, o falta el campo `image` |

**curl de prueba:**

```bash
curl -X POST http://192.168.0.11:4000/api/uploads/image \
  -H "X-Api-Key: tickets_secret_key_2026" \
  -F "image=@/ruta/a/foto.jpg"
```

---

### Paso 2 — Enviar mensaje con imagen al ticket

```http
POST http://192.168.0.11:4000/api/integrations/messages
X-Api-Key: tickets_secret_key_2026
Content-Type: application/json
```

**Body (JSON):**

```json
{
  "ticketId": "TEST-001",
  "messageType": "image",
  "content": "Aquí está el comprobante de pago",
  "agentName": "María López",
  "attachment": {
    "url": "http://192.168.0.11:4000/uploads/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg",
    "mimeType": "image/jpeg",
    "sizeBytes": 84200,
    "fileName": "comprobante.jpg"
  }
}
```

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `ticketId` | ✅ | ID del ticket (mismo que en `link`) |
| `messageType` | ✅ | `"image"` para imagen, `"text"` para texto (default) |
| `content` | ❌ | Caption / mensaje debajo de la imagen. Puede ser `""` |
| `agentName` | ❌ | Nombre del agente (se guarda en historial) |
| `attachment.url` | ✅ | URL devuelta por el paso 1 |
| `attachment.mimeType` | ✅ | Debe empezar con `image/` |
| `attachment.sizeBytes` | ❌ | Recomendado (validación de tamaño) |
| `attachment.fileName` | ❌ | Nombre original del archivo |

**Respuesta 200:**

```json
{
  "success": true,
  "message": {
    "_id": "...",
    "conversationId": "...",
    "senderType": "agent",
    "messageType": "image",
    "content": "Aquí está el comprobante de pago",
    "attachment": {
      "url": "http://192.168.0.11:4000/uploads/a1b2c3d4....jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 84200,
      "fileName": "comprobante.jpg"
    },
    "senderName": "María López",
    "timestamp": "2026-05-22T20:53:00.000Z"
  }
}
```

**curl de prueba (texto):**

```bash
curl -X POST http://192.168.0.11:4000/api/integrations/messages \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: tickets_secret_key_2026" \
  -d '{
    "ticketId": "TEST-001",
    "content": "Hola, revisamos su caso.",
    "agentName": "María López"
  }'
```

---

## Ver imágenes en la UI del ticket (historial)

```http
GET http://192.168.0.11:4000/api/integrations/conversations/{ticketId}/messages
X-Api-Key: tickets_secret_key_2026
```

**Ejemplo:**

```bash
curl http://192.168.0.11:4000/api/integrations/conversations/TEST-001/messages \
  -H "X-Api-Key: tickets_secret_key_2026"
```

**Respuesta:**

```json
{
  "success": true,
  "ticketId": "TEST-001",
  "conversationId": "...",
  "customerId": "user_test_001",
  "customerName": "Juan Pérez",
  "messages": [
    {
      "_id": "...",
      "senderType": "customer",
      "messageType": "text",
      "content": "Hola, necesito ayuda",
      "attachment": null,
      "senderName": "",
      "timestamp": "2026-05-22T20:50:00.000Z"
    },
    {
      "_id": "...",
      "senderType": "customer",
      "messageType": "image",
      "content": "Adjunto el comprobante",
      "attachment": {
        "url": "http://192.168.0.11:4000/uploads/abc.jpg",
        "mimeType": "image/jpeg",
        "sizeBytes": 120400,
        "fileName": "pago.jpg"
      },
      "senderName": "",
      "timestamp": "2026-05-22T20:51:00.000Z"
    },
    {
      "_id": "...",
      "senderType": "agent",
      "messageType": "image",
      "content": "Recibido, gracias",
      "attachment": {
        "url": "http://192.168.0.11:4000/uploads/def.png",
        "mimeType": "image/png",
        "sizeBytes": 45000,
        "fileName": "respuesta.png"
      },
      "senderName": "María López",
      "timestamp": "2026-05-22T20:53:00.000Z"
    }
  ]
}
```

### Cómo renderizar en la UI

```javascript
function renderMessage(msg) {
  if (msg.messageType === 'image' && msg.attachment?.url) {
    return `
      <motion.div class="msg msg-${msg.senderType}">
        <img src="${msg.attachment.url}" alt="Imagen" style="max-width:280px;border-radius:8px" />
        ${msg.content ? `<p>${msg.content}</p>` : ''}
        <small>${new Date(msg.timestamp).toLocaleTimeString()}</small>
      </motion.div>
    `;
  }
  return `
    <motion.div class="msg msg-${msg.senderType}">
      <p>${msg.content}</p>
      <small>${new Date(msg.timestamp).toLocaleTimeString()}</small>
    </motion.div>
  `;
}
```

- **`senderType: "customer"`** → mensaje del ciudadano (Maracaibo)
- **`senderType: "agent"`** → mensaje del agente (tickets)
- Imagen arriba, texto debajo (como WhatsApp)

---

## Código JavaScript listo para copiar (Sistema de Tickets)

```javascript
const CONNECTOR_URL = 'http://192.168.0.11:4000'; // IP del servidor del conector
const TICKETS_API_KEY = 'tickets_secret_key_2026';

/** Paso 1: subir archivo desde <input type="file"> */
async function uploadImage(file) {
  if (file.size > 3 * 1024 * 1024) {
    throw new Error('La imagen no puede superar 3 MB');
  }
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    throw new Error('Formato no permitido. Use JPG, PNG, WEBP o GIF.');
  }

  const form = new FormData();
  form.append('image', file);

  const res = await fetch(`${CONNECTOR_URL}/api/uploads/image`, {
    method: 'POST',
    headers: { 'X-Api-Key': TICKETS_API_KEY },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error al subir imagen');
  return data; // { url, mimeType, sizeBytes, fileName }
}

/** Paso 2: enviar mensaje imagen al ciudadano */
async function sendAgentImageMessage({ ticketId, file, caption, agentName }) {
  const uploaded = await uploadImage(file);

  const res = await fetch(`${CONNECTOR_URL}/api/integrations/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': TICKETS_API_KEY
    },
    body: JSON.stringify({
      ticketId,
      messageType: 'image',
      content: (caption || '').trim(),
      agentName,
      attachment: {
        url: uploaded.url,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        fileName: uploaded.fileName
      }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error al enviar mensaje');
  return data;
}

/** Cargar historial del ticket (incluye imágenes) */
async function loadTicketMessages(ticketId) {
  const res = await fetch(
    `${CONNECTOR_URL}/api/integrations/conversations/${encodeURIComponent(ticketId)}/messages`,
    { headers: { 'X-Api-Key': TICKETS_API_KEY } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error al cargar mensajes');
  return data.messages;
}

/** Mensaje de texto normal (sin cambios) */
async function sendAgentTextMessage({ ticketId, content, agentName }) {
  const res = await fetch(`${CONNECTOR_URL}/api/integrations/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': TICKETS_API_KEY
    },
    body: JSON.stringify({ ticketId, content, agentName })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error al enviar');
  return data;
}
```

### Uso en el formulario del ticket

```javascript
// fileInput = <input type="file" accept="image/jpeg,image/png,image/webp,image/gif">
// captionInput = textarea opcional
// ticketId = id del ticket abierto

document.getElementById('btnEnviarImagen').addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return alert('Selecciona una imagen');

  try {
    await sendAgentImageMessage({
      ticketId: 'TEST-001',
      file,
      caption: captionInput.value,
      agentName: 'María López'
    });
    captionInput.value = '';
    fileInput.value = '';
    // recargar historial
    const messages = await loadTicketMessages('TEST-001');
    renderChat(messages);
  } catch (err) {
    alert(err.message);
  }
});
```

---

## Esquema del mensaje (referencia rápida)

```typescript
type MessageType = 'text' | 'image';

interface ChatAttachment {
  url: string;           // http://IP:4000/uploads/uuid.ext
  mimeType: string;      // image/jpeg | image/png | image/webp | image/gif
  sizeBytes: number;
  fileName: string;
}

interface ChatMessage {
  _id: string;
  conversationId: string;
  senderType: 'customer' | 'agent';
  messageType: MessageType;
  content: string;         // texto o caption (vacío si solo imagen)
  attachment: ChatAttachment | null;
  senderName: string;
  timestamp: string;       // ISO 8601
}
```

---

## Historial y trazabilidad (MongoDB)

**Todos** los mensajes (socket + REST, texto + imagen) se guardan en la colección `messages` de MongoDB.

### Consultar historial por ticket (Sistema de Tickets)

```http
GET http://192.168.0.11:4000/api/integrations/history/ticket/TEST-001
X-Api-Key: tickets_secret_key_2026
```

**Query params opcionales:** `limit`, `skip`, `after`, `before`, `senderType` (`customer`|`agent`), `messageType` (`text`|`image`)

**Respuesta estructurada:**

```json
{
  "success": true,
  "conversation": {
    "id": "...",
    "externalTicketId": "TEST-001",
    "customerId": "user_test_001",
    "customerName": "Juan Pérez",
    "status": "active",
    "sourceChannel": "maracaibo_app",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "stats": {
    "total": 12,
    "fromCustomer": 7,
    "fromAgent": 5,
    "textCount": 10,
    "imageCount": 2,
    "inbound": 7,
    "outbound": 5
  },
  "pagination": { "total": 12, "limit": 500, "skip": 0, "returned": 12 },
  "messages": [
    {
      "_id": "...",
      "senderType": "customer",
      "messageType": "image",
      "content": "Adjunto comprobante",
      "attachment": { "url": "http://192.168.0.11:4000/uploads/....jpg", "..." : "..." },
      "deliveryChannel": "socket_client",
      "direction": "inbound",
      "externalTicketId": "TEST-001",
      "customerId": "user_test_001",
      "timestamp": "2026-05-22T20:51:00.000Z"
    }
  ]
}
```

| Campo | Significado |
|-------|-------------|
| `deliveryChannel` | `socket_client`, `socket_agent`, `rest_tickets`, `rest_maracaibo` |
| `direction` | `inbound` = ciudadano → soporte, `outbound` = agente → ciudadano |

> También funciona: `GET /api/integrations/conversations/{ticketId}/messages` (misma respuesta).

---

## Checklist para el compañero

- [ ] Misma Wi‑Fi / red local que el servidor del conector
- [ ] Usar `http://IP_LAN:4000`, nunca `localhost`
- [ ] Header `X-Api-Key: tickets_secret_key_2026` en upload y mensajes
- [ ] Flujo: **subir imagen → enviar mensaje** (no enviar binario en JSON)
- [ ] Mostrar `<img src={attachment.url}>` cuando `messageType === "image"`
- [ ] Validar en cliente: máx 3 MB, formatos JPG/PNG/WEBP/GIF
- [ ] Ticket enlazado antes con `POST /api/integrations/conversations/link`

---

## Health check

```bash
curl http://192.168.0.11:4000/api/integrations/health
```

Respuesta esperada: `{ "ok": true, ... }`
