# DEPLOY — VPS Hostinger + Easypanel

Go-live con el **número de prueba de Meta**. Arquitectura: **un solo
origen** — el frontend sirve `https://inbox.<dominio>/` y la API vive en
`https://inbox.<dominio>/api/*` (webhook incluido). Cero CORS, cookie sin
`Domain`, WS al mismo host.

```
                    ┌──────────────────────── VPS (Easypanel/Traefik) ─┐
  inbox.<dominio>/  │  path /api/*  →  servicio API  (Nest, :3001)     │
  (Let's Encrypt)   │  path /*      →  servicio Web  (Next, :3000)     │
                    │  API ⇄ inbox-postgres (:5432) ⇄ inbox-redis      │
                    └──────────────────────────────────────────────────┘
```

---

## 1. Servicios a crear (en este orden)

En el proyecto de Easypanel (p. ej. `inbox`):

### 1.1 `inbox-postgres` — Postgres 17

- **Service → Database → Postgres**, imagen `postgres:17-alpine`.
- Database: `whatsapp_inbox`, usuario/contraseña generados por Easypanel.
- **Volumen persistente**: Easypanel lo crea para bases — verificá que el
  mount `/var/lib/postgresql/data` exista antes de seguir.
- Anotá la URL interna: `postgresql://<user>:<pass>@inbox-postgres:5432/whatsapp_inbox`.

### 1.2 `inbox-redis` — Redis 7 con AOF

- **Service → Database → Redis**, imagen `redis:7-alpine`.
- **AOF obligatorio**: en la config del servicio, comando de arranque:
  `redis-server --appendonly yes --appendfsync everysec`
  Los jobs de BullMQ (webhooks encolados, descargas de media, schedulers)
  viven en Redis — sin AOF, un restart se los come.
- Volumen persistente en `/data`.

### 1.3 `inbox-api` — la API

- **Service → App → GitHub** (o Git): este repo, rama `main`.
- Build: **Dockerfile**, path `Dockerfile`, contexto `/` (raíz del repo).
- **Env**: copiá `.env.production.example` completo y reemplazá los
  `CHANGE_ME` (los marcados `[SECRETO]` van solo acá, nunca al repo).
- Puerto interno: `3001`.
- **Healthcheck** (pestaña Advanced/Health): HTTP `GET /api/health/ready`
  al puerto 3001, intervalo 30s, 3 reintentos → Easypanel reinicia el
  contenedor si Postgres/Redis dejan de responder desde la app.
  (`/api/health/live` queda para chequeos de "proceso vivo" si querés dos
  niveles; los dos van SIN auth y viven bajo el prefijo `/api` — decisión
  documentada: una sola regla de ruteo, sin excepciones.)
- Al primer deploy, el entrypoint corre `prisma migrate deploy` solo
  (seguro con UNA instancia; con réplicas se movería a un job de release).

### 1.4 `inbox-web` — el frontend

- **Service → App → GitHub**: mismo repo.
- Build: **Dockerfile**, path `web/Dockerfile`, **contexto `web/`**.
- Env: **ninguna** (el frontend llama `/api` relativo).
- Puerto interno: `3000`.
- Healthcheck opcional: HTTP `GET /login` al 3000.

---

## 2. Dominio, SSL y ruteo por path

1. DNS: registro `A` de `inbox.<dominio>` → IP del VPS.
2. En `inbox-web` → **Domains**: agregá `inbox.<dominio>`, HTTPS on
   (Let's Encrypt lo emite Easypanel), path `/`, puerto 3000.
3. En `inbox-api` → **Domains**: agregá **el mismo** `inbox.<dominio>`,
   HTTPS on, **path `/api`**, puerto 3001. **No** actives "strip path":
   la API espera el prefijo `/api` (global prefix de Nest).
4. Traefik rutea por longitud de path: `/api/*` gana sobre `/` — el
   orden de creación no importa, pero verificá con:
   ```bash
   curl -s https://inbox.<dominio>/api/health/ready   # → {"status":"ok",...}
   curl -sI https://inbox.<dominio>/login             # → 200 del Next
   ```
5. **WebSocket**: el handshake vive en `/api/socket.io` (path explícito
   del gateway y del cliente), así que entra por la misma regla `/api` y
   Traefik maneja el upgrade solo. Verificación rápida post-login: la UI
   sin el badge "Reconectando…" y en los logs de la API cero warnings
   de "Handshake rechazado".

---

## 3. Primer arranque

1. Deploy de `inbox-postgres` y `inbox-redis` primero; después `inbox-api`
   (sus migraciones corren al boot y el `/health/ready` pasa a 200);
   después `inbox-web`.
2. Si la API no arranca: los logs (JSON por línea) dicen exactamente qué
   env falta — la validación de entorno corta el boot con la lista.
3. **Seed** (una vez): consola del servicio `inbox-api` →
   ```bash
   npx prisma db seed
   ```
   Con las `SEED_*` del paso 1.3 crea tenant + Meta App (cifrada) + cuenta
   del número de prueba + owner con password. El resumen del seed avisa si
   quedó algo en placeholder.
4. Entrá a `https://inbox.<dominio>/login` con `SEED_OWNER_EMAIL` +
   `SEED_OWNER_PASSWORD`. Desde Ajustes → Usuarios creá a la cajera.

---

## 4. Backups (sin esto no hay producción)

**Opción A — pestaña Backups de Easypanel (preferida si tu versión la
tiene para Postgres):** destino S3 = R2 con las credenciales
`R2_BACKUP_*` (bucket `whatsapp-inbox-backups`, APARTE del de media),
schedule diario 04:00, retención 14 días si el panel lo soporta.

**Opción B — cron con el script del repo:** creá un servicio App con
imagen `alpine` + `postgresql17-client` + `aws-cli` (o un cron del VPS)
que corra [`scripts/backup-db.sh`](scripts/backup-db.sh) una vez al día
con `DATABASE_URL` y las `R2_BACKUP_*`. El script hace
`pg_dump | gzip → R2` y poda lo más viejo que 14 días.

**Probá una restauración** antes del go-live:
`gunzip -c backup.sql.gz | psql $DATABASE_URL` contra una DB vacía.

---

## 5. Cutover del webhook de Meta

Hoy el webhook apunta al túnel de dev. Para producción:

1. Panel de Meta → tu app → WhatsApp → **Configuration → Webhook** →
   **Edit**: Callback URL = `https://inbox.<dominio>/api/webhooks/whatsapp`.
2. Verify token: **el mismo** que ya está en la DB (lo cifró el seed; es
   tu `SEED_WEBHOOK_VERIFY_TOKEN`). **No hace falta re-seed**: Meta hace
   el GET de verificación y la API responde con el token de la DB.
3. Verificá suscripción al campo `messages` (ya estaba de dev).
4. ⚠ **Dev local queda desconectado**: el webhook apunta a producción.
   Para volver a desarrollar con webhooks en vivo: levantar el túnel y
   cambiar la Callback URL de nuevo (y revertirla al terminar). Si esa
   fricción se vuelve diaria, la salida limpia es una **Meta App de test
   separada** con su propio número de prueba apuntando al túnel —
   anotado como opción, no implementado.

---

## 6. Smoke de producción (los 6 pasos)

Con el celular real contra el número de prueba (tiene que estar en la
lista de destinatarios de prueba de Meta):

1. **Entrante en vivo**: mandá "hola" por WhatsApp al número de prueba →
   la conversación aparece en `https://inbox.<dominio>/inbox` en <2s, con
   sonido y contador en el título de la pestaña.
2. **Respuesta + tildes**: respondé desde el inbox → llega al celular;
   las tildes pasan de ✓ a ✓✓ y a azules al leerlo.
3. **Mark-read**: abrí la conversación en el inbox → en el celular tu
   "hola" queda con tildes azules (cortesía mark-read hacia Meta).
4. **Plantilla**: con el composer, "Plantillas" → `hello_world` (la de
   prueba de Meta) → llega al celular.
5. **Ventana**: verificá la barra de ventana drenando en el hilo y el
   chip con countdown en la lista (abierta tras el paso 1).
6. **Media**: mandá una foto desde el celular → se ve en el hilo (302 a
   R2 firmada); mandá una foto desde el inbox → llega al celular.

Si los 6 pasan: producción operativa. Dejá una pestaña con los logs de la
API abierta la primera hora — el request logging canta cualquier 5xx.

---

## 7. Operación

- **Deploy de una nueva versión**: push a `main` → Rebuild en ambos
  servicios (o auto-deploy si lo activaste). La API drena limpio en el
  restart: SIGTERM → deja de aceptar conexiones → desconecta el WS (los
  clientes reconectan solos) → espera los jobs de BullMQ en curso (techo
  30s) → cierra Prisma/Redis. Orden documentado en `src/http/shutdown.ts`.
- **Logs**: JSON por línea (`LOG_LEVEL=info`). Cada request loguea
  método, path, status, duración y userId/tenantId de sesión — nunca
  tokens, cookies, bodies ni querystrings.
- **Sesiones**: expiran a los 30 días sliding; un job diario (04:30)
  barre las vencidas abandonadas. Rate limit de login vive en Redis (5
  fallos/15min por email+IP) y sobrevive deploys.
- **El número real** entra después por otro camino (no contemplado acá).
