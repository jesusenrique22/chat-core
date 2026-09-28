# chat-core

API de chat en tiempo real (Express + Socket.io + MongoDB). Conecta **Servicios Maracaibo** con el **Sistema de Tickets**.

Solo backend: REST + WebSockets. Sin HTML, widgets ni dashboard en este repo.

## Arranque

```bash
pnpm install
cp .env.example .env   # completar TODAS las variables [OBLIGATORIA]
SEED_CONFIRM=yes pnpm run seed   # opcional, BORRA la BDD (bloqueado en producción)
pnpm run backend       # http://0.0.0.0:4000
```

Producción (PM2):

```bash
pnpm run start:pm2
pnpm run reload:pm2    # deploys
```

Sin `REDIS_URL` PM2 arranca **1 instancia** (Socket.io guarda las salas en memoria del proceso).
Con `REDIS_URL` se activa el adaptador Redis y se puede escalar a varias instancias/réplicas;
en ese caso los clientes deben conectar con `transports: ['websocket']` o el balanceador
necesita sticky sessions.

## Pruebas

```bash
pnpm run test:hardening   # seguridad + regresión contra server.js real (Mongo en memoria, no toca .env)
```

## Superficie

| Canal | Auth |
|-------|------|
| REST `/api/integrations/*`, `/api/uploads/image` | `X-Api-Key` de plataforma |
| Socket `/client` | `auth.apiKey` + datos de cliente (+ `auth.token` si hay `CLIENT_TOKEN_SECRET`) |
| Socket `/agent` | `auth.apiKey` de agente — obligatorio con `AUTH_ENFORCE=true` |
| REST `/api/conversations*`, bandeja/respuesta de citas | `X-Api-Key` de agente — obligatorio con `AUTH_ENFORCE=true` |
| REST crear/consultar citas, departamentos | `X-Api-Key` de plataforma — obligatorio con `AUTH_ENFORCE=true` |

Key de agente = la del **Sistema de Tickets** o una de `AGENT_API_KEYS`.
`AUTH_ENFORCE=false` (default) mantiene compatibilidad mientras los frontends se actualizan;
en producción se registra un aviso `insecure_config` hasta activarlo.

Los webhooks al Sistema de Tickets van por una cola persistente en Mongo (`webhookjobs`)
con timeout y reintentos con backoff: no se pierden si Tickets cae o el proceso se reinicia.

## Observabilidad

- `GET /api/integrations/health` → `ok`, `mongo`, `uptimeSec` (503 si Mongo caído)
- Logs JSON (`LOG_LEVEL=info|warn|error|debug`)

## Docs

- `DOCUMENTACION-RAILWAY.md` — desplegar en Railway y conectar con Tickets
- `INTEGRACION.md` — contratos REST / Socket Maracaibo ↔ Tickets
- `DOCUMENTACION-RENDER.md` — guía legacy Render
