# Cambios y mejoras: seguridad, bugs y escalabilidad

**Rama:** `hardening/seguridad-escalabilidad` · **Commit:** `7a43e5b`

Este documento resume lo que se corrigió en chat-core, por qué se corrigió y qué hay que hacer para activar las protecciones que quedaron apagadas por compatibilidad.

---

## Resumen

| Área | Qué cambió |
|---|---|
| Seguridad | Las API keys ya no se filtran. Se bloqueó la inyección NoSQL y el ReDoS. CORS es estricto. La autenticación de agentes y citas está lista (se activa con `AUTH_ENFORCE`). |
| Bugs | Disponibilidad y capacidad de citas, eventos al ciudadano, presencia, mensajes duplicados, límites de agentes, entre otros. |
| Escalabilidad | Cola persistente de webhooks con reintentos. Adaptador Redis opcional. Consultas más livianas. Índices depurados. |
| Código | `server.js` se dividió en módulos y hay un manejador central de errores. |
| Pruebas | Nueva suite `npm run test:hardening` (39 comprobaciones). Las 3 suites existentes siguen pasando. |

**Compatibilidad:** las respuestas que usan los frontends no cambiaron, salvo los detalles de la sección [Cambios de contrato](#cambios-de-contrato).

---

## 1. Seguridad

### 1.1 Las API keys ya no se exponen 🔴
- **Antes:** `GET /api/conversations` (sin autenticación), los eventos `conversation_updated` del socket y varias respuestas REST devolvían la plataforma completa, **incluida su `apiKey`**. Cualquiera podía obtener las claves de Maracaibo y de Tickets.
- **Ahora:** `Platform.apiKey` tiene `select: false`, así que nunca sale en consultas ni en `populate`. Además, los `populate` piden solo el campo `name`.
- **Archivos:** `src/models/Platform.js`, `server.js`, `src/lib/integrations.js`, `src/lib/messageStore.js`

### 1.2 Inyección NoSQL 🔴
- **Antes:** el handshake del socket `/client` pasaba `apiKey` y `customerId` directo a Mongo. Enviando `{"$ne": null}` se saltaba la autenticación o se accedía a la conversación de otro ciudadano.
- **Ahora:** todas las entradas externas (socket y REST) pasan por `asString` / `asObjectId`, que rechazan objetos y arrays.
- **Archivos:** `src/lib/validate.js` (nuevo), `src/sockets/clientNamespace.js`, `src/lib/integrations.js`

### 1.3 ReDoS por expresión regular 🔴
- **Antes:** `new RegExp(textoDelUsuario)` al buscar departamentos. Un patrón malicioso podía bloquear el servidor y uno inválido lo hacía fallar.
- **Ahora:** el texto se escapa con `escapeRegex` y su longitud está limitada.
- **Archivo:** `src/lib/appointments.js`

### 1.4 CORS estricto 🔴
- **Antes:**
  - `origin.includes('localhost')` aceptaba `https://localhost.evil.com`.
  - `origin.startsWith(permitido)` aceptaba `http://localhost:3000.evil.com`.
  - En cada arranque se volvía a añadir `'*'` a las plataformas, así que no se podía cerrar CORS desde la base de datos.
- **Ahora:**
  - Se compara el hostname exacto o un comodín `*.dominio.com` real.
  - Al arrancar solo se sincroniza `CORS_EXTRA_ORIGINS`.
  - Si `CORS_ALLOW_ALL=true` en producción, se registra un aviso `insecure_config`.
- **Archivos:** `src/lib/cors.js`, `src/lib/env.js`

### 1.5 Autenticación de agentes, conversaciones y citas 🔴 (apagada por defecto)
- **Antes:** el socket `/agent`, `/api/conversations*` y todas las rutas de citas estaban abiertas. Cualquiera podía leer todos los chats, escribir como agente, cerrar conversaciones, consultar datos personales por cédula y resolver citas.
- **Ahora:** está implementada, pero **solo se exige con `AUTH_ENFORCE=true`** para no romper los frontends actuales.

| Recurso | Credencial requerida con `AUTH_ENFORCE=true` |
|---|---|
| Socket `/agent` | `auth.apiKey` de agente |
| `GET /api/conversations*` | `X-Api-Key` de agente |
| Bandeja de departamento, mensajes y respuesta de citas | `X-Api-Key` de agente |
| Departamentos, disponibilidad, crear y consultar citas | `X-Api-Key` de cualquier plataforma |

- **Key de agente** = la de la plataforma **Sistema de Tickets** o una de `AGENT_API_KEYS`. La key pública de Maracaibo **no** sirve como key de agente.
- Las API keys se guardan en caché en memoria (60 s), así que ya no hay una consulta a Mongo por cada petición.
- **Archivos:** `src/lib/auth.js` (nuevo), `src/sockets/agentNamespace.js`, `src/lib/appointmentRoutes.js`, `server.js`

### 1.6 Suplantación de ciudadanos 🔴
- **Antes:** con la key pública de Maracaibo, un cliente podía conectarse con el `ticketId` de otra persona. El servidor le reasignaba la conversación y exponía todo el historial.
- **Ahora:**
  - Con `AUTH_ENFORCE=true` se rechaza unirse a un ticket que pertenece a otro `customerId`. En modo compatible se mantiene el comportamiento anterior, pero queda registrado en el log (`client_ticket_owner_reassigned`).
  - **Opcional, protección real:** con `CLIENT_TOKEN_SECRET`, el socket exige `auth.token = HMAC-SHA256(secret, "customerId:ticketId")`, generado por el backend de Maracaibo.
- **Archivos:** `src/lib/integrations.js`, `src/lib/auth.js`

### 1.7 Subida de imágenes
- La API key se valida **antes** de recibir el archivo. Antes se guardaban hasta 3 MB en memoria incluso sin key.
- Se verifica la firma binaria real del archivo (JPG, PNG, GIF, WEBP), porque el `mimetype` que manda el cliente no es fiable.
- Hay timeout hacia el bucket (`BUCKET_TIMEOUT_MS`, 15 s por defecto), límites de campos multipart y el nombre del archivo se limpia.
- **Archivo:** `src/lib/uploads.js`

### 1.8 Otros
- **Claves por defecto:** en producción, si falta `MARACAIBO_API_KEY` al crear las plataformas por primera vez, se genera una clave aleatoria en lugar de usar `maracaibo_secret_key_2026`.
- **`seed.js`** (borra la base de datos) está bloqueado en producción y pide `SEED_CONFIRM=yes`.
- **Errores:** los 5xx devuelven "Error interno del servidor" sin detalles internos. El detalle se guarda en el log (`src/lib/errors.js`).
- **Límites de tamaño:** el body JSON pasa de 1 MB a 256 KB (`JSON_BODY_LIMIT`) y el paquete de Socket.io de 1 MB a 256 KB (`SOCKET_MAX_BUFFER_BYTES`).
- **`/health`** ya no expone la URL del webhook de Tickets.
- **Cabecera `x-powered-by`** desactivada.
- **Dependencias:** `npm audit fix` resolvió 9 vulnerabilidades, entre ellas una DoS en `ws`. Ahora hay 0.

---

## 2. Bugs corregidos

| # | Bug | Corrección | Archivo |
|---|---|---|---|
| 1 | La disponibilidad de citas buscaba con el slug (`"valuacion"`) en lugar del `_id` del departamento: nunca contaba reservas y todo aparecía libre. | Usa `dept._id` y una agregación por horario. | `appointments.js` |
| 2 | No había control de capacidad: se podía sobre-agendar un horario. | Si el horario está lleno responde **409**. | `appointments.js` |
| 3 | `appointment_updated` se enviaba a la sala `room_<id>`, pero el ciudadano está en `<id>`: nunca le llegaba. | Se emite a la sala correcta. | `appointments.js` |
| 4 | Los mensajes de una cita se ordenaban por `createdAt`, un campo que `Message` no tiene. | Se ordenan por `timestamp`, con límite. | `appointmentRoutes.js` |
| 5 | El código de cita tenía 9000 combinaciones por año y un `while` que podía colgarse, además de una condición de carrera. | `crypto.randomInt`, reintento ante duplicado usando el índice único, y paso a 6 dígitos si hay colisiones. | `appointments.js` |
| 6 | `seedDepartmentsIfEmpty` sobrescribía en cada arranque la capacidad y los jefes editados en la base de datos. | `$setOnInsert`: solo crea los que faltan. | `appointments.js` |
| 7 | Al crear una cita podía quedar una conversación huérfana si la cita fallaba. `platformId` no se validaba. | Primero se crea la cita y luego la conversación. `platformId` se valida. | `appointments.js` |
| 8 | Al cerrar una pestaña el ciudadano quedaba offline aunque tuviera otra abierta. | Se comprueba si quedan sockets en la sala antes de marcarlo offline. | `clientNamespace.js` |
| 9 | Tras un reinicio, las conversaciones quedaban `isOnline: true` para siempre. | Se reinician al arrancar (sin Redis). | `server.js` |
| 10 | Los agentes recibían `new_message` y `client_presence` **dos veces** (sala del chat + dashboard). | Una sola emisión a varias salas, que Socket.io deduplica. | `messageStore.js`, sockets |
| 11 | El agente compartía el límite del ciudadano (10 mensajes por minuto). | Límite propio `AGENT_SEND_MESSAGE_MAX_PER_MIN` (120 por defecto). | `agentNamespace.js` |
| 12 | `agent_join` sin datos lanzaba una excepción fuera de `try`. | Entradas validadas. | `agentNamespace.js` |
| 13 | `close_conversation` con un ID inexistente respondía `success: true` con `null`. | Responde un error controlado. Además guarda `closedAt` y `closedBy`. | `agentNamespace.js` |
| 14 | Las estadísticas del historial se calculaban solo sobre la página devuelta. | Se calculan sobre el total con una agregación. | `messageStore.js` |
| 15 | La disponibilidad dependía de la zona horaria del servidor (`setHours`). | Ventana de día UTC explícita, coherente con cómo se guardan las fechas. | `appointments.js` |
| 16 | Dos conexiones simultáneas podían crear **dos conversaciones activas** para el mismo ticket. | Índice único parcial + recuperación ante duplicado. | `Conversation.js`, `integrations.js` |
| 17 | Los datos del handshake por `query` nunca se leían (`auth \|\| query`, y `auth` siempre es `{}`). | Se lee de `auth` primero y luego de `query`. | `clientNamespace.js` |
| 18 | `/overdue` aceptaba `hours` negativo o infinito y no tenía límite configurable. | `hours` se acota a entre 1 y 2160, y se añade `limit` (máx. 500). | `integrations.js` |

> **Nota:** la lógica del SLA de `/overdue` (inactividad del ciudadano) **se mantuvo**, porque así la define la suite `test-overdue-and-tickets.js`.

---

## 3. Rendimiento y escalabilidad

### 3.1 Webhooks con cola persistente y reintentos 🟡
- **Antes:** cada mensaje hacía un `fetch` sin esperar respuesta, sin timeout ni reintentos. Si Tickets estaba lento, las peticiones se acumulaban en memoria. Si fallaba o el proceso se reiniciaba, la notificación **se perdía**.
- **Ahora:** los webhooks se guardan en la colección `webhookjobs` y un worker los envía:
  - con timeout (`WEBHOOK_TIMEOUT_MS`, 5 s);
  - con reintentos y espera creciente, hasta `WEBHOOK_MAX_ATTEMPTS` (8);
  - con concurrencia limitada (`WEBHOOK_CONCURRENCY`, 5);
  - de forma segura con varias instancias, gracias a un bloqueo por `lockedUntil`;
  - los envíos terminados se borran solos a los 7 días (índice TTL).
- **Archivos:** `src/lib/webhooks.js`, `src/models/WebhookJob.js` (nuevos)

### 3.2 Varias instancias: adaptador Redis 🟡
- **Antes:** PM2 arrancaba en `cluster` con `instances: 'max'` y **sin** adaptador. Los mensajes de un proceso no llegaban a los agentes conectados a otro, y el long-polling fallaba con "Session ID unknown".
- **Ahora:**
  - Con `REDIS_URL`, Socket.io usa `@socket.io/redis-adapter` y los eventos se comparten entre instancias.
  - Sin `REDIS_URL`, PM2 arranca **1 instancia** en modo `fork`.
  - Con varias instancias, los clientes deben usar `transports: ['websocket']` o el balanceador necesita sticky sessions.
- **Archivos:** `src/lib/socketAdapter.js` (nuevo), `ecosystem.config.js`, `server.js`

### 3.3 Consultas
- `.lean()` en lecturas (sin crear documentos Mongoose).
- **Listados con límite:**
  - `GET /api/conversations`: 500 por defecto, máximo 1000, con cursor `?before=` y cabecera `X-Has-More`.
  - Bandeja de departamento: 500.
  - Citas por cédula: 100.
  - Mensajes de cita: 500.
  - Páginas por socket: 200.
- **Historial:** antes hacía `countDocuments` y recorría los mensajes 7 veces para las estadísticas; ahora usa una sola agregación en paralelo con la consulta.
- **Mensaje nuevo:** `recordMessage` devuelve la conversación actualizada, así que ya no se vuelve a consultar.
- **Marcar como leído:** `markMessagesReadByCustomer` hace un solo `updateMany` en lugar de `exists` + `updateMany`.
- **Plataformas:** la de Maracaibo se guarda en caché (antes se cargaban todas en cada `join_chat`).

### 3.4 Índices
- **Eliminados por redundantes** (cubiertos por índices compuestos o poco usados):
  - `Message`: `conversationId`, `deliveryChannel`, `direction`, `externalTicketId`, `customerId`, `readByCustomerAt`.
  - `Conversation`: `customerId`, `externalTicketId`, `status`, `lastCustomerMessageAt`.
- **Nuevos:**
  - `Message {conversationId, senderType, readByCustomerAt}`
  - `Conversation {status, lastCustomerMessageAt}`
  - `Conversation {isOnline}`
  - `Conversation uniq_active_ticket`: índice único parcial, una conversación activa por ticket.

> Mongoose **no borra** los índices viejos de una base de datos existente. Hay que borrarlos a mano para recuperar el rendimiento de escritura.

### 3.5 Robustez del proceso
- Registro de `unhandledRejection` y `uncaughtException` (en este último el proceso sale para que PM2 o Railway lo reinicien).
- **Cierre ordenado:** sockets y HTTP → cola de webhooks → Redis → Mongo, con timeout.
- Los rate limits de REST responden en JSON con `success: false`.

---

## 4. Estructura del código

```
server.js                      ← arranque y composición (antes 720 líneas con todo dentro)
src/
  lib/
    auth.js          (nuevo)   autenticación de plataformas y agentes, caché, token HMAC
    errors.js        (nuevo)   HttpError + manejador central de errores
    validate.js      (nuevo)   coerción de entradas (anti-inyección)
    webhooks.js      (nuevo)   cola persistente de webhooks
    socketAdapter.js (nuevo)   adaptador Redis opcional
  sockets/
    clientNamespace.js (nuevo) eventos del ciudadano (/client)
    agentNamespace.js  (nuevo) eventos del agente (/agent)
  models/
    WebhookJob.js    (nuevo)
scripts/
  test-hardening.js  (nuevo)   pruebas de seguridad y regresión
```

Nuevas dependencias: `@socket.io/redis-adapter`, `redis`.

---

## 5. Variables de entorno nuevas

Todas son **opcionales**. Si no se definen, el comportamiento es compatible con el anterior.

| Variable | Default | Uso |
|---|---|---|
| `AUTH_ENFORCE` | `false` | `true` exige credenciales en agentes, conversaciones y citas |
| `AGENT_API_KEYS` | — | Keys extra para el panel de agentes (separadas por coma) |
| `CLIENT_TOKEN_SECRET` | — | Exige un token HMAC en el socket `/client` |
| `REDIS_URL` | — | Activa el adaptador Redis (varias instancias) |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Timeout de cada webhook |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | Reintentos máximos |
| `WEBHOOK_CONCURRENCY` | `5` | Webhooks en paralelo |
| `AGENT_SEND_MESSAGE_MAX_PER_MIN` | `120` | Límite de mensajes del agente |
| `RATE_LIMIT_APPOINTMENTS_CREATE` | `10` | Citas creadas por minuto y por IP |
| `RATE_LIMIT_APPOINTMENTS_LOOKUP` | `60` | Consultas de citas por minuto y por IP |
| `JSON_BODY_LIMIT` | `256kb` | Tamaño máximo del body |
| `SOCKET_MAX_BUFFER_BYTES` | `262144` | Tamaño máximo de un paquete de Socket.io |
| `BUCKET_TIMEOUT_MS` | `15000` | Timeout al subir al bucket |
| `PLATFORM_CACHE_TTL_MS` | `60000` | Caché de API keys |
| `SEED_CONFIRM` | — | Debe ser `yes` para ejecutar `seed.js` |

---

## 6. Cambios de contrato

Son pequeños, pero conviene revisarlos en los frontends:

1. **`GET /api/conversations`** devuelve como máximo **500** conversaciones (antes, todas). Usa `?limit=` (máx. 1000), `?before=<updatedAt>` y la cabecera `X-Has-More`.
2. Las **respuestas de error** incluyen `success: false` además de `error`.
3. Los errores 500 muestran un mensaje genérico. El detalle está en el log.
4. **`/health`** ya no incluye `notificationsWebhook`.
5. **Crear una cita en un horario lleno** responde **409** (antes se aceptaba).
6. **Códigos de error más precisos** en citas: 404 si no existe, 400 si los datos son inválidos (antes casi todo era 400 o 500).
7. **`POST /api/appointments`** con datos incompletos indica en el mensaje qué campos faltan.

---

## 7. Pruebas

```bash
npm run test:hardening
```

- Arranca el `server.js` **real** con Mongo en memoria y un webhook falso. **No toca el `.env` ni la base de datos real.**
- Se ejecuta dos veces: con `AUTH_ENFORCE=false` y con `AUTH_ENFORCE=true`.
- **Resultado: 39 de 39 comprobaciones OK.** Cubre fugas de keys, inyección NoSQL, ReDoS, CORS, capacidad y disponibilidad de citas, `appointment_updated`, deduplicación de mensajes, presencia con varias pestañas, reintentos de webhooks, autenticación de agentes y protección de tickets.

**Suites existentes, sin modificar, contra el servidor nuevo:**

| Suite | Resultado |
|---|---|
| `scripts/test-e2e.js` | 12/12 ✅ |
| `scripts/test-appointment-flow.js` | flujo completo ✅ |
| `scripts/test-overdue-and-tickets.js` | 8/8 ✅ |

**No probado:** varias instancias con Redis real (no había Redis ni Docker disponibles). Solo se verificó que los módulos cargan.

---

## 8. Pendientes y recomendaciones

1. **Activar `AUTH_ENFORCE=true`** cuando los frontends estén actualizados:
   - Panel de agentes: `io('/agent', { auth: { apiKey: '<key de Tickets>' } })`.
   - Peticiones REST de agentes y citas: cabecera `X-Api-Key`.
2. **Cambiar las claves `NOTIFICATIONS_API_KEY` y `BUCKET_API_KEY`**: ya estaban escritas en archivos del repositorio antes de estos cambios (`INTEGRACION.md`, `DOCUMENTACION-RENDER.md` y los scripts de prueba).
3. **Cerrar CORS en producción:** `CORS_ALLOW_ALL=false` y quitar `*.up.railway.app` de `CORS_EXTRA_ORIGINS`, porque cualquier app en Railway, también de terceros, pasaría.
4. **Suplantación de ciudadanos:** la key de Maracaibo es pública (va en el frontend). La protección definitiva es `CLIENT_TOKEN_SECRET`, con el token firmado por el backend de Maracaibo.
5. **Base de datos existente:**
   - Borrar los índices viejos listados en 3.4.
   - Si ya hay tickets con dos conversaciones activas, el índice `uniq_active_ticket` no se creará (aparece como error en el log). Hay que cerrar los duplicados y reiniciar.
6. **Si se escala a varias instancias:**
   - Configurar `REDIS_URL`.
   - Los rate limits siguen en memoria por instancia.
   - `connectionStateRecovery` no funciona con el adaptador Redis clásico.
7. **Capacidad de citas:** entre la comprobación de cupo y la creación queda una ventana muy pequeña en la que dos solicitudes simultáneas podrían ocupar el mismo cupo. Si llega a importar, se puede resolver con un contador atómico por horario.
