# Plan de Seguridad y Optimización — chat-core

**Contexto:** Backend hospedado en droplet DigitalOcean, ejecutado con PM2, tráfico WebSocket a través de nginx. Se reportan saturación y caídas del servicio.

**Objetivo:** Corregir vulnerabilidades críticas y cuellos de botella de rendimiento de forma incremental, sin tumbar producción.

---

## Resumen ejecutivo

El sistema funciona bien en desarrollo, pero en producción acumula problemas graves en dos frentes:

| Frente | Estado actual |
|--------|---------------|
| **Seguridad** | Rate limit + helmet + throttle mensajes (Fase 2). `/agent` y `/api/conversations*` abiertos. Keys de plataformas y CORS permisivo se mantienen. |
| **Rendimiento** | Broadcasts globales a todos los agentes, CORS consulta MongoDB en cada request, `join_chat` carga 500 mensajes por reconexión, reconexión infinita en el widget |

La combinación de nginx mal tuneado + reconexiones en loop + broadcasts globales explica el patrón **"se satura → se cae → todos reconectan → se satura más"**.

---

## Fase 0 — Diagnóstico (antes de tocar código)

**Duración estimada:** 1–2 horas  
**Riesgo:** ninguno (solo lectura)

### Checklist en el droplet

```bash
# Conexiones activas
ss -s
lsof -i :4000 | wc -l

# Memoria y restarts del proceso
pm2 describe chat-backend
pm2 logs chat-backend --lines 200

# Errores nginx
sudo tail -100 /var/log/nginx/error.log

# ¿Reconexiones en loop?
pm2 logs chat-backend | grep -E "Cliente|desvinculado|join_chat" | tail -50
```

### Señales y qué significan

| Señal observada | Causa probable |
|-----------------|----------------|
| Miles de `Cliente conectado` / `desvinculado` en poco tiempo | nginx corta WebSockets o timeout bajo → tormenta de reconexiones |
| RAM al 90%+ constante | Broadcasts globales + historial grande en `join_chat` + `connectionStateRecovery` |
| MongoDB con muchas conexiones / queries lentas | CORS sin cache (query a DB en cada handshake) + `join_chat` repetido |
| `EADDRINUSE` o `heap out of memory` en PM2 logs | Proceso único saturado; droplet pequeño sin `max_memory_restart` |

### Entregable

- [ ] Captura de `pm2 monit` bajo carga normal y bajo pico
- [ ] Config nginx actual (pegar en este doc o en ticket)
- [ ] Tamaño del droplet (RAM/CPU) y si MongoDB está en el mismo servidor
- [ ] Número aproximado de clientes concurrentes y agentes conectados

---

## Fase 1 — Estabilidad urgente (sin cambios de auth)

**Duración estimada:** 1–2 días  
**Riesgo:** bajo  
**Impacto:** alto — debería reducir caídas de inmediato

Estas acciones no requieren coordinar con clientes externos (Maracaibo / Tickets) más allá de variables de entorno.

### 1.1 nginx — WebSockets

Verificar o aplicar esta configuración mínima:

```nginx
upstream chat_backend {
    ip_hash;
    server 127.0.0.1:4000;
    keepalive 64;
}

location /socket.io/ {
    proxy_pass http://chat_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_connect_timeout 60s;
    proxy_buffering off;
}

client_max_body_size 5m;
```

**Errores típicos que provocan caídas:**
- `proxy_read_timeout` en 60s (default) → nginx cierra conexiones idle
- Falta header `Upgrade` / `Connection: upgrade`
- `proxy_buffering on` en rutas WebSocket

### 1.2 PM2 — límites de memoria

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'chat-backend',
    script: 'server.js',
    instances: 1,              // NO usar cluster sin Redis adapter
    exec_mode: 'fork',
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 4000
    }
  }]
};
```

> **Importante:** PM2 en modo `cluster` con múltiples instancias **rompe** Socket.io sin `@socket.io/redis-adapter`. Mantener `instances: 1` hasta Fase 4.

### 1.3 Variables de entorno en producción

```env
NODE_ENV=production
PORT=4000
MONGODB_URI=mongodb://...

CORS_ALLOW_LAN=false
CORS_ALLOW_ALL=false
CORS_EXTRA_ORIGINS=https://app.maracaibo.com,https://tickets.tudominio.com

PUBLIC_BASE_URL=https://chat.tudominio.com
```

### 1.4 Cambios de código (Fase 1)

| # | Cambio | Archivo(s) | Por qué |
|---|--------|------------|---------|
| 1 | Cachear orígenes CORS en memoria (TTL ~5 min) | `src/lib/cors.js` | Elimina `Platform.find()` en cada handshake HTTP/socket |
| 2 | Reemplazar `agentNamespace.emit(...)` global por emisiones a room `conversationId` | `server.js`, `src/lib/messageStore.js`, `src/lib/integrations.js` | Cada evento ya no llega a TODOS los agentes |
| 3 | Reducir historial en `join_chat` a últimos 50 mensajes | `src/lib/messageStore.js` | Menos carga en cada reconexión |
| 4 | Limitar reconexiones del widget: `reconnectionAttempts: 20` + backoff | `public/widget.js` | Evita tormenta tras caída del servidor |
| 5 | Throttle server-side de `client_typing` / `agent_typing` (ej. 1 evento / 2s por socket) | `server.js` | Deja de broadcastear cada keystroke a todos |
| 6 | (omitido) No cambiar contrato REST de `/api/conversations` | — | Mantener respuesta = array |

### Criterios de éxito Fase 1

- [ ] Sin picos de reconexión tras 30+ min de inactividad en un chat abierto
- [ ] RAM estable bajo carga normal (< 70% del droplet)
- [ ] Logs sin ráfagas de `join_chat` repetidos por el mismo `customerId`
- [ ] Latencia de mensajes < 500ms en condiciones normales

### Fase 1 — implementado en código (2026-07-13)

| # | Cambio | Estado |
|---|--------|--------|
| 1 | Cache CORS en memoria (`src/lib/cors.js`) | ✅ |
| 2 | Sala `agents-dashboard` en lugar de broadcasts globales | ✅ |
| 3 | `join_chat` carga últimos 50 mensajes | ✅ |
| 4 | Reconexión limitada a 20 intentos (widget) | ✅ |
| 5 | Throttle typing server-side (2s) | ✅ |
| 6 | `GET /api/conversations` paginado | ✅ |
| — | `ecosystem.config.js` para PM2 | ✅ |

**Pendiente en el droplet (manual):** nginx WebSockets, `.env` producción, `pm2 start ecosystem.config.js`

---

## Fase 2 — Seguridad crítica

**Duración estimada:** 3–5 días  
**Riesgo:** medio  
**Impacto:** cierra vulnerabilidades graves

### Alcance acordado (adaptación)

Este repo es **solo backend**. Se eliminó el dashboard Next.js (`src/app/*`, React).

**Se implementa:**
- Rate limiting REST, throttle `send_message`, `helmet`, `express.json` 1mb
- Logs sin contenido de mensajes
- Eliminar dashboard Next.js del repo

**Se pospone / se mantiene a petición:**
- Auth en `/agent` y `/api/conversations*` (queda abierto como antes)
- Rotación de API keys de plataformas (Maracaibo/Tickets)
- CORS permisivo (sin endurecer `*`, `startsWith` ni LAN)

### Fase 2 — implementado en código (2026-07-14)

| # | Cambio | Estado |
|---|--------|--------|
| 1–2 | Auth de agentes (`AGENT_API_KEY`) | ⏸ revertido — queda abierto |
| 3 | Rotar API keys de plataformas | ⏸ pospuesto |
| 4–5 | Endurecer CORS | ⏸ se mantiene permisivo |
| 6 | `express-rate-limit` en REST | ✅ |
| 7 | Rate limit `send_message` (10/min por socket) | ✅ |
| 8 | `express.json({ limit: '1mb' })` | ✅ |
| 9 | `helmet` | ✅ |
| 10 | Logs sin texto de mensajes | ✅ |
| — | Eliminar dashboard Next.js del repo | ✅ |

### Criterios de éxito Fase 2

- [x] Rate limit activo en `/api/integrations`, `/api/conversations`, `/api/uploads`
- [x] `/agent` y `/api/conversations*` accesibles sin token de agente
- [ ] (Opcional futuro) Auth agentes + rotar keys + CORS estricto

---

## Fase 3 — Optimización de base de datos y flujos

**Duración estimada:** 3–5 días  
**Riesgo:** bajo–medio  
**Impacto:** reduce latencia y carga en MongoDB

### 3.1 Problemas actuales

| Problema | Detalle |
|----------|---------|
| Múltiples roundtrips por mensaje | `Message.create` + `Conversation.update` + `Platform.find` + emits + webhook |
| `join_chat` pesado | Resuelve conversación (varias queries) + carga historial + marca leídos + webhook + broadcast |
| `mark_messages_read` en cada mensaje nuevo | Widget emite lectura por mensaje → DB update + webhook externo |
| Historial default 500 msgs, máx 2000 | `parseHistoryQuery` en `messageStore.js` |
| `/api/conversations` sin límite | Carga todas las activas con `populate` |
| Uploads sin limpieza | Directorio `uploads/` crece indefinidamente |

### 3.2 Cambios de código (Fase 3)

| # | Cambio | Archivo(s) |
|---|--------|------------|
| 1 | Batch de operaciones en `recordMessage` (menos queries) | `src/lib/messageStore.js` |
| 2 | `join_chat`: no marcar leídos ni webhook si no hay mensajes nuevos | `server.js` |
| 3 | Debounce de `mark_messages_read` en widget (1 emit cada 3s máx) | `public/widget.js` |
| 4 | Historial paginado con cursor (`before` timestamp) en widget y dashboard | varios |
| 5 | Índice compuesto `{ status: 1, updatedAt: -1 }` en Conversation | `src/models/Conversation.js` |
| 6 | Cron de limpieza de uploads locales | ⏸ obsoleto — imágenes en bucket remoto |
| 7 | Mover webhooks a cola async (setImmediate o Bull/BullMQ) | `src/lib/messageStore.js` |
| 8 | Reducir `connectionStateRecovery` a 30s o desactivar en producción | `server.js` |

### Fase 3 — implementado en código (2026-07-14)

| # | Cambio | Estado |
|---|--------|--------|
| 1 | `recordMessage`: create + update en paralelo; sin `Platform.find` extra | ✅ |
| 2 | `markMessagesRead`: early exit con `exists`; join_chat en paralelo post-callback | ✅ |
| 3 | Debounce 3s `mark_messages_read` en widget | ✅ |
| 4 | Cursor `before` + evento `load_older_messages` + botón en widget | ✅ |
| 5 | Índice `{ status: 1, updatedAt: -1 }` | ✅ |
| 6 | Uploads locales | ⏸ bucket remoto |
| 7 | Webhooks vía `setImmediate` | ✅ |
| 8 | Recovery 30s en `production` (`SOCKET_RECOVERY_MS`) | ✅ |

### 3.3 MongoDB en producción

**Recomendación:** no compartir MongoDB en el mismo droplet que el backend si hay >100 clientes concurrentes.

| Opción | Cuándo usarla |
|--------|---------------|
| MongoDB en el mismo droplet | < 50 clientes concurrentes, droplet ≥ 4 GB RAM |
| MongoDB Atlas / droplet dedicado | > 100 clientes, o si la DB compite por RAM con Node |

### Criterios de éxito Fase 3

- [x] `join_chat` responde el historial antes de marcar leídos / emits
- [x] Sin unread → sin update ni webhook de lectura
- [x] Widget no emite lectura por cada mensaje (debounce 3s)
- [x] Historial hacia atrás con cursor / `load_older_messages`
- [x] Imágenes en bucket (sin cron local)

---

## Fase 4 — Escalabilidad horizontal

**Duración estimada:** 1–2 semanas  
**Riesgo:** alto (cambio arquitectónico)  
**Impacto:** permite crecer más allá de un solo proceso Node

### 4.1 Cuándo activar esta fase

- Más de 500 conexiones WebSocket concurrentes
- RAM del proceso Node > 80% de forma sostenida tras Fases 1–3
- Necesidad de zero-downtime deploys

### 4.2 Cambios requeridos

| # | Cambio | Descripción |
|---|--------|-------------|
| 1 | `@socket.io/redis-adapter` | Compartir rooms entre instancias PM2 |
| 2 | PM2 `instances: max` o N fijo | Cluster mode con Redis |
| 3 | Redis en droplet o Upstash/DO Managed Redis | Backend del adapter |
| 4 | Sticky sessions en nginx (`ip_hash`) | Mientras no haya Redis adapter |
| 5 | CDN para `/uploads` (DO Spaces + CDN) | Descargar serving de archivos del proceso Node |
| 6 | Separar Next.js dashboard del backend | Dashboard en Vercel/otro servicio; solo API en droplet |
| 7 | Health checks + alertas (Uptime Kuma, DO Monitoring) | Detección proactiva |

### 4.3 Arquitectura objetivo

```
                    ┌─────────────┐
  Clientes ────────►│   nginx     │
  (widget/app)      │  (SSL/WS)   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         PM2 inst 1   PM2 inst 2   PM2 inst N
              └────────────┼────────────┘
                           │
                    ┌──────▼──────┐
                    │    Redis    │  ← Socket.io adapter
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   MongoDB   │  ← Atlas o droplet dedicado
                    └─────────────┘
```

### Criterios de éxito Fase 4

- [ ] 2+ instancias PM2 compartiendo rooms correctamente
- [ ] Mensaje de cliente llega al agente sin importar qué instancia atiende
- [ ] Deploy sin desconexión masiva de clientes

---

## Fase 5 — Hardening y operaciones

**Duración estimada:** continuo  
**Riesgo:** bajo  
**Impacto:** mantenimiento a largo plazo

### 5.1 Panel de gestión

Actualmente las plataformas solo se gestionan vía `seed.js`. Objetivo:

- [ ] UI admin para crear/revocar plataformas y API keys
- [ ] Activar/desactivar plataformas sin borrar datos
- [ ] Vista de métricas: conexiones activas, mensajes/min, errores

### 5.2 Autenticación de agentes (completa)

- [ ] Login con usuario/contraseña o SSO
- [ ] Roles: agente, supervisor, admin
- [ ] Auditoría de acciones (quién cerró conversación, quién respondió)

### 5.3 Observabilidad

| Herramienta | Qué monitorear |
|-------------|----------------|
| PM2 logs | Errores, reconexiones, OOM |
| nginx access/error log | 502/504, timeouts WS |
| MongoDB | Conexiones activas, slow queries |
| Alertas | RAM > 85%, proceso caído, disco > 90% |

### 5.4 Backups y DR

- [ ] Backup diario de MongoDB (Atlas lo hace automático; si es local, `mongodump` cron)
- [ ] Backup de `uploads/` a DO Spaces
- [ ] Procedimiento documentado de restore

### 5.5 Tests de carga

Antes de cada fase mayor, ejecutar:

```bash
# Con backend en marcha
npm run test:connector

# Prueba de carga básica (instalar artillery o k6)
# Simular 100 conexiones socket concurrentes + 10 msg/s
```

---

## Mapa de archivos afectados por fase

| Archivo | F1 | F2 | F3 | F4 |
|---------|:--:|:--:|:--:|:--:|
| `server.js` | ✅ | ✅ | ✅ | ✅ |
| `src/lib/cors.js` | ✅ | ✅ | — | — |
| `src/lib/messageStore.js` | ✅ | ✅ | ✅ | ✅ |
| `src/lib/integrations.js` | ✅ | — | — | — |
| `public/widget.js` | ✅ | — | ✅ | — |
| `public/widget.js` | ✅ | — | ✅ | — |
| `src/models/Conversation.js` | — | — | ✅ | — |
| `seed.js` | — | ✅ | — | — |
| `ecosystem.config.js` (nuevo) | ✅ | — | — | ✅ |
| nginx config (servidor) | ✅ | — | — | ✅ |

---

## Orden de implementación recomendado

```
Fase 0  →  Diagnóstico (hoy)
   ↓
Fase 1  →  nginx + PM2 + cache CORS + rooms + paginación  ← MÁXIMO IMPACTO / MÍNIMO RIESGO
   ↓
Fase 2  →  Auth agentes + rotar keys + rate limit + CORS estricto
   ↓
Fase 3  →  Optimizar DB + debounce + limpieza uploads
   ↓
Fase 4  →  Redis adapter + cluster (solo si la carga lo exige)
   ↓
Fase 5  →  Admin panel + observabilidad + backups (continuo)
```

---

## Referencia: problemas documentados en código

### Broadcasts globales (Fase 1)

```javascript
// server.js — cada connect/disconnect de cliente
agentNamespace.emit('conversation_updated', populatedConv);
agentNamespace.emit('client_presence_global', presencePayload);

// messageStore.js — cada mensaje de cliente
agentNamespace.emit('conversation_message_received', { ... });

// server.js — cada keystroke
agentNamespace.emit('conversation_typing', payload);
```

**Fix:** usar `agentNamespace.to(conversationId).emit(...)` o sala `agents-online`.

### CORS con query a DB (Fase 1)

```javascript
// cors.js — en CADA request
const allPlatforms = await Platform.find().select('allowedOrigins');
```

**Fix:** cache en memoria con invalidación al modificar plataformas.

### Reconexión infinita (Fase 1)

```javascript
// widget.js
reconnectionAttempts: Infinity
```

**Fix:** `reconnectionAttempts: 20`, `reconnectionDelayMax: 10000`.

### Endpoints sin auth (Fase 2)

```javascript
// server.js
expressApp.get('/api/conversations', ...)        // sin middleware
expressApp.get('/api/conversations/:id/messages', ...)  // sin middleware
agentNamespace.on('connection', ...)             // sin middleware
```

---

## Notas para el equipo

- **No activar PM2 cluster** hasta tener Redis adapter (Fase 4).
- **Coordinar con Maracaibo y Tickets** antes de rotar API keys (Fase 2).
- **Probar en staging** cada fase antes de desplegar al droplet.
- El script `npm run test:connector` valida el flujo básico; ampliar con pruebas de carga tras Fase 1.

---

*Documento generado a partir del análisis de seguridad y optimización del proyecto chat-core. Actualizar conforme se completen las fases.*
