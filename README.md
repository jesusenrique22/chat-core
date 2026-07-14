# chat-core (conector de chat)

Backend Express + Socket.io + MongoDB. Conecta **Servicios Maracaibo** (ciudadanos) con el **Sistema de Tickets** (agentes) vía REST y WebSockets.

## Arranque

```bash
npm install
cp .env.example .env   # completar TODAS las variables [OBLIGATORIA]
npm run seed           # opcional; también auto-siembra al arrancar
npm run backend        # http://0.0.0.0:4000
```

Si falta alguna variable crítica (`MONGODB_URI`, `CORS_*`, `BUCKET_*`, `NOTIFICATIONS_*`), el proceso **sale con error** y no usa defaults.

En `NODE_ENV=production`, si MongoDB no responde el proceso **termina** (sin DB en memoria). En desarrollo el fallback in-memory sigue disponible salvo `ALLOW_MEMORY_MONGO=false`.

Producción con PM2:

```bash
npm run start:pm2
# deploys (cierre ordenado de sockets + wait_ready):
npm run reload:pm2
```

## Auth

| Canal | Credencial |
|-------|------------|
| Widget / app (`/client`) | API Key de plataforma (`X-Api-Key` / `auth.apiKey`) |
| Integraciones Tickets/Maracaibo | API Key de plataforma |
| Namespace `/agent` y `GET /api/conversations*` | Abierto (sin auth; monitoreo externo) |

## Observabilidad

- Health: `GET /api/integrations/health` → `ok`, `mongo`, `uptimeSec` (503 si Mongo caído)
- Logs: una línea JSON por evento (`level`, `msg`, …). Nivel con `LOG_LEVEL=info|warn|error|debug`

## Docs

- `INTEGRACION.md` — conector Maracaibo ↔ Tickets
- `PLAN-SEGURIDAD-OPTIMIZACION.md` — plan por fases
