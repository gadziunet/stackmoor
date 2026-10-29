# ---- zależności (better-sqlite3 to moduł natywny) ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- obraz końcowy ----
FROM node:22-alpine
WORKDIR /app

LABEL org.opencontainers.image.title="stackpanel" \
      org.opencontainers.image.description="Simple web UI for Docker Compose stacks" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Klient Dockera i wtyczka compose (statyczne binarki z oficjalnego obrazu).
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=5001 \
    DATA_DIR=/app/data \
    STACKS_DIR=/opt/stacks

EXPOSE 5001
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:5001/api/state >/dev/null || exit 1

CMD ["node", "src/server.js"]
