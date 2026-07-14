# chat-core

API de chat en tiempo real (Express + Socket.io + MongoDB). Conecta **Servicios Maracaibo** con el **Sistema de Tickets**.

Solo backend: REST + WebSockets. Sin HTML, widgets ni dashboard en este repo.

## Arranque

```bash
pnpm install
cp .env.example .env   # completar TODAS las variables [OBLIGATORIA]
pnpm run seed          # opcional
pnpm run backend       # http://0.0.0.0:4000
```

Producción (PM2):

```bash
pnpm run start:pm2
pnpm run reload:pm2    # deploys
```

## Superficie

| Canal | Auth |
|-------|------|
| REST `/api/integrations/*`, `/api/uploads/image` | `X-Api-Key` de plataforma |
| Socket `/client` | `auth.apiKey` + datos de cliente |
| Socket `/agent` | Abierto (monitoreo) |
| REST `/api/conversations*` | Abierto (monitoreo) |

## Observabilidad

- `GET /api/integrations/health` → `ok`, `mongo`, `uptimeSec` (503 si Mongo caído)
- Logs JSON (`LOG_LEVEL=info|warn|error|debug`)

## Docs

- `INTEGRACION.md` — contratos REST / Socket Maracaibo ↔ Tickets
