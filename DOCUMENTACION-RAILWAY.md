# Despliegue en Railway: chat-core ↔ Sistema de Tickets

Guía para subir **chat-core** a Railway y dejarlo conectado con el **Sistema de Tickets** (ya desplegado).

---

## 1. Subir chat-core a Railway

1. New Project / Add Service → conecta el repo `chat-core`.
2. Railway detectará `Dockerfile` + `railway.toml`.
3. En el servicio → **Settings → Networking → Generate Domain**  
   Anota la URL, ej. `https://chat-core-production-xxxx.up.railway.app`.
4. Healthcheck: `/health` (ya configurado en `railway.toml`).

---

## 2. Variables en chat-core (Railway → Variables)

| Variable | Valor |
|----------|--------|
| `NODE_ENV` | `production` |
| `CORS_ALLOW_LAN` | `false` |
| `CORS_ALLOW_ALL` | `true` (luego puedes cerrarlo) |
| `TRUST_PROXY_HOPS` | `1` |
| `MONGODB_URI` | tu URI de Mongo |
| `BUCKET_UPLOAD_URL` | `https://api-bucket.smart.com.ve/api/imau/upload` |
| `BUCKET_API_KEY` | tu key del bucket |
| `BUCKET_FOLDER` | `ticket_chat` |
| `NOTIFICATIONS_API_URL` | `https://ticketsotravez-production-43fd.up.railway.app/notifications/ticket` |
| `NOTIFICATIONS_API_KEY` | misma key que usa el Sistema de Tickets |
| `PUBLIC_BASE_URL` | `https://<TU-CHAT-CORE>.up.railway.app` |

No definas `PORT` a mano: Railway lo inyecta.

---

## 3. Variables en el Sistema de Tickets (Railway)

| Variable | Valor |
|----------|--------|
| `CHAT_API_URL` | `https://<TU-CHAT-CORE>.up.railway.app` |
| `CHAT_API_KEY` | misma que `NOTIFICATIONS_API_KEY` / plataforma “Sistema de Tickets” |

Sin esto, tickets no puede llamar a chat-core (mensajes de agente, historial, cierre).

---

## 4. Flujo bidireccional

```
Ciudadano → chat-core → POST NOTIFICATIONS_API_URL  → Tickets (aviso de mensaje)
Agente    → Tickets   → POST CHAT_API_URL/api/integrations/messages → chat-core → ciudadano
```

API key compartida: header `X-Api-Key` = `NOTIFICATIONS_API_KEY` / `CHAT_API_KEY`.

Si Mongo está vacío, al arrancar chat-core auto-crea las plataformas y usa `NOTIFICATIONS_API_KEY` para “Sistema de Tickets”.

---

## 5. Verificación rápida

```bash
# chat-core vivo
curl https://<TU-CHAT-CORE>.up.railway.app/health

# health profundo (Mongo)
curl https://<TU-CHAT-CORE>.up.railway.app/api/integrations/health

# link de prueba (desde tickets / Maracaibo)
curl -X POST https://<TU-CHAT-CORE>.up.railway.app/api/integrations/conversations/link \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <CHAT_API_KEY>" \
  -d '{"ticketId":"TEST-001","customerId":"user_1","customerName":"Prueba"}'
```

---

## 6. Checklist

- [ ] Dominio público generado en chat-core
- [ ] Vars de chat-core configuradas (sobre todo `NOTIFICATIONS_API_URL`)
- [ ] En tickets: `CHAT_API_URL` + `CHAT_API_KEY`
- [ ] `/health` responde `ok: true`
- [ ] Mensaje de agente en tickets llega al chat
- [ ] Mensaje de ciudadano dispara notificación en tickets
