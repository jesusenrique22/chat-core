# chat-core — despliegue en Railway (también compatible con Render)
FROM node:20-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Railway inyecta PORT; 4000 es solo el default local
EXPOSE 4000

ENV NODE_ENV=production
# Railway cobra la RAM usada: sin tope, V8 deja crecer el heap hasta ~2 GB antes de recolectar.
# 256 MB sobra para una instancia; se puede subir con la variable NODE_OPTIONS en Railway.
ENV NODE_OPTIONS=--max-old-space-size=256

# wget viene en busybox (alpine); no hace falta instalarlo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/health" || exit 1

CMD ["node", "server.js"]
