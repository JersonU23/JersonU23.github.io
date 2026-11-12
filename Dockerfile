# FITNESS AI — imagen de producción
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencias primero (aprovecha la caché de capas)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts ./scripts

# Ejecutar sin privilegios de root
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

# El arranque aplica las migraciones pendientes y levanta el servidor
CMD ["node", "src/server.js"]
