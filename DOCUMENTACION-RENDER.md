# Guía de Despliegue en Render: `chat-core` + Sistema de Tickets

Esta guía explica paso a paso cómo desplegar `chat-core` en **Render** y conectarlo de manera bidireccional con el **Sistema de Tickets** (`ticketsotravez-1.onrender.com`).

---

## 📋 Requisitos Previos

1. Cuenta activa en [Render.com](https://render.com).
2. El repositorio `chat-core` subido a tu cuenta de GitHub.
3. El Sistema de Tickets ejecutándose en Render (`https://ticketsotravez-1.onrender.com`).

---

## 🚀 Opción 1: Despliegue Automático con Render Blueprint (Recomendado)

1. En el panel de Render, haz clic en **New +** -> **Blueprint**.
2. Conecta el repositorio `chat-core`.
3. Render detectará automáticamente el archivo [`render.yaml`](file:///Users/smart/Documents/GitHub/chat-core/render.yaml).
4. Asigna los valores para las variables secretas que Render solicitará:
   - `MONGODB_URI`: Tu cadena de conexión de MongoDB Atlas o DigitalOcean.
   - `BUCKET_API_KEY`: Clave de la API del bucket de imágenes.
5. Haz clic en **Apply** para iniciar el despliegue.

---

## 🛠️ Opción 2: Despliegue Manual (Web Service)

1. En el panel de Render, haz clic en **New +** -> **Web Service**.
2. Selecciona el repositorio `chat-core`.
3. Configura los siguientes parámetros:
   - **Name:** `chat-core` (o el nombre que prefieras)
   - **Environment:** `Node` (o `Docker` si usas el `Dockerfile`)
   - **Region:** Oregon (o la misma región de tu sistema de tickets para menor latencia)
   - **Branch:** `main`
   - **Build Command:** `pnpm install || npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`

4. En la sección **Environment Variables**, agrega:

| Variable | Valor Recomendado / Descripción |
|---|---|
| `NODE_ENV` | `production` |
| `CORS_ALLOW_LAN` | `false` |
| `CORS_ALLOW_ALL` | `true` |
| `TRUST_PROXY_HOPS` | `1` |
| `MONGODB_URI` | `mongodb+srv://...` (Tu URI de producción) |
| `BUCKET_UPLOAD_URL` | `https://api-bucket.smart.com.ve/api/imau/upload` |
| `BUCKET_API_KEY` | `1093cfbc5214591fb67ae2556ed61bc1222cf40dd34fbc8346f6a183537937302d3ab7a1079eadc13b02ac6d364b02a0c4172049e7bba43f44cd77740ef12d81` |
| `BUCKET_FOLDER` | `ticket_chat` |
| `NOTIFICATIONS_API_URL` | `https://ticketsotravez-1.onrender.com/notifications/ticket` |
| `NOTIFICATIONS_API_KEY` | `tickets_secret_key_2026` |

---

## 🔗 Conexión con el Sistema de Tickets

Para que el **Sistema de Tickets** (`ticketsotravez-1.onrender.com`) pueda interactuar con `chat-core`, asegúrate de configurar las siguientes variables de entorno en el Web Service del Sistema de Tickets en Render:

| Variable en Tickets | Valor |
|---|---|
| `CHAT_API_URL` | `https://<tu-app-chat-core>.onrender.com` |
| `CHAT_API_KEY` | `tickets_secret_key_2026` |

---

## 🧪 Verificación del Despliegue

Una vez que Render finalice el despliegue:

1. Visita la URL de tu servicio en el navegador o ejecuta `curl`:
   ```bash
   curl https://<tu-app-chat-core>.onrender.com/health
   ```
2. Deberás recibir una respuesta HTTP 200 similar a esta:
   ```json
   {
     "ok": true,
     "service": "chat-core",
     "status": "live",
     "notificationsWebhook": "https://ticketsotravez-1.onrender.com/notifications/ticket",
     "time": "2026-08-20T10:45:00.000Z"
   }
   ```
