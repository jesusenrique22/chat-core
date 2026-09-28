# chat-core — despliegue en Railway (también compatible con Render)
FROM node:20-alpine AS base

RUN apk add --no-cache wget

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Railway inyecta PORT; 4000 es solo el default local
EXPOSE 4000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/health" || exit 1

CMD ["node", "server.js"]
