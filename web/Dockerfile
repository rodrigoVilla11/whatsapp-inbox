# ── Web (Next.js standalone) — multi-stage, no-root ──────────────────────
# Contexto de build: el directorio web/ del repo.
# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# output: 'standalone' (next.config.ts) → server.js autocontenido.
# NEXT_PUBLIC_API_ORIGIN NO se define: producción usa rutas relativas /api.
ENV NODE_ENV=production
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
