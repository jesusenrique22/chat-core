# Dockerfile optimizado para despliegue de chat-core en Render
FROM node:20-alpine AS base

# Configurar directorio de trabajo
WORKDIR /app

# Copiar manifiestos e instalar dependencias de producción
COPY package*.json ./
RUN npm ci --only=production

# Copiar código de la aplicación
COPY . .

# Exponer el puerto de la aplicación (Render asignará PORT automáticamente)
EXPOSE 4000

# Variables de entorno por defecto
ENV NODE_ENV=production

# Comando de inicio del servidor
CMD ["node", "server.js"]
