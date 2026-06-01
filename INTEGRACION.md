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

## CORS y compartir en red local (sin VPN)

Tu compañero debe estar en la **misma Wi‑Fi/red** que tú.

### 1. Arranca el backend y copia la IP

```bash
npm run backend
```

La consola muestra algo como:

```
📡 Compartir en red local (sin VPN):
   Backend + widget:  http://192.168.1.50:4000
```

Pasa esa URL a tu compañero.

### 2. URLs para compartir

| Recurso | URL |
|---------|-----|
| Widget / API | `http://TU_IP:4000` |
| Demo Maracaibo | `http://TU_IP:4000/maracaibo.html` |
| Dashboard agentes | `http://TU_IP:3000` |
| Health | `http://TU_IP:4000/api/integrations/health` |

### 3. CORS automático en LAN

Con `CORS_ALLOW_LAN=true` (por defecto en `.env`) se permiten orígenes:

- `192.168.x.x` (Wi‑Fi doméstica/oficina)
- `10.x.x.x` y `172.16–31.x.x`
- `localhost`

### 4. Widget en la web del compañero

```html
<script
  src="http://192.168.1.50:4000/widget.js"
  data-api-key="maracaibo_secret_key_2026"
  data-customer-name="Nombre"
  data-server-url="http://192.168.1.50:4000">
</script>
```

(Reemplaza `192.168.1.50` por tu IP real.)

### 5. Demo proyecto externo (otro puerto)

```bash
npx serve demo-cliente-externo -p 8181
```

Abrir: `http://IP_DEL_COMPAÑERO:8181?server=192.168.1.50`

### 6. Si usas túnel (ngrok, etc.)

Agrega la URL en `.env`:

```env
CORS_EXTRA_ORIGINS=https://xxxx.ngrok-free.app
```

### 7. macOS: permitir conexiones entrantes

Preferencias → Red → Firewall: permitir **Node** en red privada.

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

**Eventos:** `join_chat`, `send_message`, `client_typing` (sin cambios).

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

Las imágenes se guardan en disco (`uploads/`); MongoDB solo almacena la URL (~150 bytes).

```bash
curl -X POST http://localhost:4000/api/uploads/image \
  -H "X-Api-Key: maracaibo_secret_key_2026" \
  -F "image=@/ruta/foto.jpg"
```

Respuesta:

```json
{
  "success": true,
  "url": "http://192.168.0.11:4000/uploads/abc-uuid.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 84200,
  "fileName": "foto.jpg"
}
```

- Formatos: JPG, PNG, WEBP, GIF
- Tamaño máximo: 3 MB (`UPLOAD_MAX_BYTES` en `.env`)
- Si los clientes acceden por IP LAN distinta al host del servidor, define `PUBLIC_BASE_URL=http://TU_IP:4000` en `.env` para que las URLs de imagen sean accesibles
- **Importante:** Si abres el chat con `localhost`, las imágenes nuevas ya salen con IP LAN (`PUBLIC_BASE_URL`). Tu compañero debe abrir el widget con `http://TU_IP:4000/...`, no `localhost`.
- En la app del compañero, el script del widget **debe** incluir `data-server-url="http://TU_IP:4000"` para subir y ver imágenes.

**Parámetros de imagen (ciudadano y agente):**

| Regla | Valor |
|-------|--------|
| Formatos | JPG, PNG, WEBP, GIF |
| Tamaño máximo | 3 MB |
| Campo multipart | `image` |
| Header upload | `X-Api-Key: maracaibo_secret_key_2026` (ciudadano) o `tickets_secret_key_2026` (agente/tickets) |

**Widget en la máquina del compañero (misma Wi‑Fi):**

```html
<script
  src="http://192.168.0.11:4000/widget.js"
  data-api-key="maracaibo_secret_key_2026"
  data-server-url="http://192.168.0.11:4000"
  data-customer-name="Nombre"
  data-ticket-id="TEST-001">
</script>
```

(Reemplaza `192.168.0.11` por la IP que muestra `npm run backend`.)

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
      "url": "http://192.168.0.11:4000/uploads/abc-uuid.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 84200,
      "fileName": "comprobante.jpg"
    },
    "agentName": "María López"
  }'
```

---

## Widget web (prueba rápida)

En `maracaibo.html` ya incluye `data-ticket-id="TEST-001"`.

1. Reinicia backend: `kill $(lsof -t -i :4000); npm run backend`
2. Abre `http://localhost:4000/maracaibo.html` y abre el chat
3. Ejecuta el `curl` del paso 2 (mensajes desde tickets)
4. Debe aparecer el mensaje en el widget al instante

**Nota:** El `customerId` del widget se genera en `localStorage`. Para prueba con curl, primero ejecuta `link` y usa el mismo flujo, o borra `localStorage` y fija `customerId` en el HTML si lo personalizas.

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

## Dashboard de agentes (monitoreo)

`http://TU_IP:3000` — muestra conversaciones y el **Ticket: TEST-001** en la cabecera. Los mensajes enviados por la API de tickets también aparecen aquí.

---

## Script de prueba automática

```bash
npm run test:connector
```

(Requiere backend en marcha en el puerto 4000.)
