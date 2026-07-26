# ── API (NestJS + Prisma) — multi-stage, imagen final slim, no-root ──────
# Contexto de build: la RAÍZ del repo. El web tiene su propio Dockerfile.
# syntax=docker/dockerfile:1

FROM node:22-slim AS base
# openssl: lo necesitan los engines de Prisma
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Dependencias de runtime solamente (prisma CLI está en dependencies:
# el entrypoint corre `prisma migrate deploy`).
FROM base AS prod-deps
RUN npm ci --omit=dev \
  && npx prisma generate

# Build con todas las dependencias (nest CLI es devDep)
FROM base AS build
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npx prisma generate && npx nest build

# ── Runtime ──────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
# src/ viaja a runtime SOLO para el seed (prisma/seed.ts importa el hasher
# y el cifrado desde src/ y corre con tsx, que está en dependencies).
COPY --chown=node:node src ./src
COPY --chown=node:node tsconfig.json package.json ./

USER node
EXPOSE 3001

# migrate deploy ANTES de arrancar: con UNA instancia es seguro (Prisma
# toma advisory lock en Postgres). Si algún día hay réplicas, esto se mueve
# a un job de release separado y el CMD queda solo `node dist/main.js`.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
