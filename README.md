# whatsapp-inbox

Inbox de WhatsApp (Cloud API oficial de Meta) para Nova Sushi, escrito
multi-tenant desde el primer commit para integrarse como feature de
Gourmetify vía Embedded Signup.

Stack: NestJS + Prisma + PostgreSQL + BullMQ/Redis + Next.js + R2.

## Setup de desarrollo

```bash
cp .env.example .env      # completar ENCRYPTION_KEY y (opcional) SEED_*
npm install
npm run db:up             # Postgres :5434 + Redis :6380 (puertos corridos a propósito)
npm run db:migrate
npm run db:seed           # tenant Nova Sushi + MetaApp + WhatsappAccount
npm run start:dev
```

`npm run typecheck` y `npm test` son las verificaciones estáticas.

## Decisiones que sostienen el multi-tenant

### Credenciales en la base, cifradas — nunca en env

`.env` solo lleva infraestructura (`DATABASE_URL`, `REDIS_URL`,
`ENCRYPTION_KEY`). Todo lo de WhatsApp (`accessToken`, `appSecret`,
`verifyToken`, `phoneNumberId`, `wabaId`) vive en Postgres, cifrado con
AES-256-GCM (envelope `v1.<keyVersion>.<iv>.<tag>.<ct>`, ver
`src/crypto/encryption.ts`). Los campos se llaman `*Enc` a propósito: no
existe `account.accessToken` para loguear por accidente.

Las `SEED_*` de `.env` se leen **una sola vez** durante el seed para
cifrarlas a la base. El runtime jamás las lee de env.

Rotación de clave: `ENCRYPTION_KEYS='{"1":"...","2":"..."}'` +
`ENCRYPTION_ACTIVE_KEY_VERSION=2`. Lo viejo se sigue descifrando con v1;
lo nuevo sale con v2 (`keyVersion` en cada fila).

### MetaApp separado de Tenant

Modelo Tech Provider: una sola Meta App, todos los WABAs de todos los
restaurantes cuelgan de ella. El `appSecret` y el `verifyToken` son de la
**app**, no del tenant — la firma `X-Hub-Signature-256` se valida sobre el
raw body *antes* de poder parsear el payload y resolver el tenant.
`MetaApp.ref` deja prevista la ruta `/webhooks/whatsapp/:ref` para el caso
raro de un tenant con app propia.

### Tenant guard en runtime (además de los tipos)

Todo el data access pasa por `PrismaService.db`
(`src/prisma/prisma.service.ts`), que encadena dos extensiones:

- **tenant-guard** (`src/prisma/tenant-guard.ts`): tira
  `MissingTenantScopeError` ante cualquier query sobre `Contact`,
  `Conversation`, `Message`, `MessageTemplate` o `QuickReply` cuyo `where`
  no incluya `tenantId` (directo, `{ equals }`, unique compuesto o dentro
  de `AND`). `OR`/`NOT` no cuentan como scope. Creates exigen `tenantId`
  en `data`. Fail-closed: operación desconocida no pasa.
  Fuera del guard: `Tenant`/`MetaApp`/`WebhookEvent` (plataforma),
  `WhatsappAccount` (el webhook la busca por `phoneNumberId` global para
  *resolver* el tenant) y `User` (login por email).
  Consecuencia práctica: buscar por id se escribe
  `findFirst({ where: { id, tenantId } })`, nunca `findUnique({ where: { id } })`.
- **soft-delete** (`src/prisma/soft-delete.ts`): las lecturas de
  `Contact`/`Conversation`/`Message` filtran `deletedAt: null` por defecto.
  `findUnique` se redirige a `findFirst` expandiendo el unique compuesto
  (pasa por el guard igual). Para incluir borrados: `...WITH_DELETED` en el
  where. Las escrituras no se filtran (restaurar/purgar necesitan alcanzar
  filas borradas).

El `PrismaClient` crudo es privado del servicio: no hay camino sin guard.

### Retención y borrado

`RetentionService` (`src/retention/retention.service.ts`):

- `purgeContact(tenantId, contactId)`: borrado **físico** de contacto +
  conversaciones + mensajes en una transacción, y después la media en R2
  (best-effort, fuera de la transacción). Es el camino para "cliente pide
  que borren su conversación". Hoy la media va al `NoopMediaStorage`; en
  fase 5 se registra la implementación R2 sin tocar el servicio.
- `purgeWebhookEvents()`: poda `PROCESSED`/`DISCARDED` más viejos que
  `WEBHOOK_RETENTION_DAYS` (default 60). `FAILED` se conserva hasta
  revisión manual. Corre como job repeatable diario (ver Mantenimiento).

### Pricing por mensaje

`Message` guarda `billable` / `pricingModel` / `pricingCategory` /
`pricingType` tal cual los manda Meta en `statuses[].pricing` (strings, sin
enums propios: las categorías cambian con cada actualización de pricing).
Desde oct 2026 Meta cobra mensajes de servicio; sin esto no hay backfill.
`@@index([tenantId, billable, timestamp])` responde "cuánto gastó este
tenant este mes" con un index scan.

### Webhook (fase 2)

Rutas:

- `GET /webhooks/whatsapp` (y `/:ref`): verificación de Meta. El
  `hub.verify_token` se compara (timing-safe) contra el token **descifrado
  de la MetaApp** resuelta por ref — nunca contra env. El `hub.challenge`
  se responde como **texto plano** (la serialización JSON default de Nest
  lo devolvería entre comillas y la verificación falla sin error obvio).
  Ref inexistente → 404.
- `POST /webhooks/whatsapp` (y `/:ref`): valida `X-Hub-Signature-256`
  (HMAC-SHA256 del **raw body** con el app secret descifrado,
  `crypto.timingSafeEqual` con chequeo de longitud previo). Firma
  ausente/ inválida → 401 sin persistir. Firma válida → `WebhookEvent`
  RECEIVED → job en BullMQ **con solo el id del evento** → QUEUED → 200.
  Cero parseo de mensajes en el request. Ref inexistente → **200 igual**
  (404 repetidos hacen que Meta marque el endpoint caído) + evento
  DISCARDED. Error interno post-firma → log + FAILED + **200 igual**.

Body parsers (`src/http/body-parsers.ts`): `/webhooks` recibe **solo raw**
— la firma se calcula sobre los bytes exactos del wire, y un JSON inválido
con firma válida debe dar 200 (con `express.json()` global el parser corta
400 antes del controller). El `JSON.parse` lo hace el service en try/catch.

Cola (`src/queue/queue.module.ts`): reintentos 5 con backoff exponencial
desde 3s, `removeOnComplete` por edad+cantidad y `removeOnFail` a 7 días
para que Redis no crezca sin techo. El worker que consume es fase 3.

### Worker (fase 3)

`src/webhook-worker/`: consumidor de la cola. El processor es fino; la
lógica vive en `WebhookEventHandler` (testeable sin Redis).

- **Contrato con BullMQ**: evento inexistente / ya terminado / payload
  imparseable / tenant irresoluble → job OK sin throw (reintentar no lo
  arregla; queda `DISCARDED` con motivo). Solo errores reales (DB caída)
  hacen throw → reintento con el backoff de la cola. Todo el reproceso es
  seguro porque la persistencia es idempotente.
- **Resolución de tenant**: `value.metadata.phone_number_id` →
  `WhatsappAccount` → `tenantId`, por change (un payload puede traer
  múltiples entries con `messages[]` y `statuses[]` mezclados).
- **Entrantes** (`inbound-messages.service.ts`), en transacción y en este
  orden: upsert `Contact` (resucita soft-deleted) → upsert `Conversation`
  (unique triple, sin contadores) → `create` de `Message` con captura de
  P2002 (**reintento de Meta = no-op, jamás infla `unreadCount`**) → recién
  si el create creó: `lastInboundAt`/`lastMessageAt` con guarda monotónica,
  `unreadCount { increment: 1 }` atómico, y reapertura si estaba `CLOSED`.
  Decisiones deliberadas: reacciones refrescan `lastInboundAt` y pisan el
  preview ("Reaccionó 👍") pero **no** suman `unreadCount`; entrantes se
  guardan con `status: DELIVERED`; `LOCATION`/`CONTACTS` llevan su detalle
  como JSON en `body` (raw sigue reservado a UNSUPPORTED/errores).
- **Statuses** (`message-statuses.service.ts`): avance monotónico
  PENDING < SENT < DELIVERED < READ vía `updateMany` condicional
  (compare-and-set en la DB); un status tardío no retrocede el estado pero
  sella su timestamp si estaba null. FAILED es terminal y sella
  `failedAt` + `errorCode/Title/Detail`. El objeto `pricing` se mapea
  cuando aparece (solo claves presentes — un status posterior sin pricing
  no pisa con null). Salientes confirmados actualizan `lastOutboundAt`.
- **Timestamps**: Meta manda epoch en **segundos** — `parseEpochSeconds`
  multiplica ×1000 (test que fija el bug clásico del 1970).

### Mantenimiento (purga programada)

`src/maintenance/`: job repeatable de BullMQ (`upsertJobScheduler`, cron
`0 4 * * *`) que corre `purgeWebhookEvents()`. Sin doble ejecución con N
réplicas: el scheduler es idempotente por id y BullMQ entrega cada job a un
solo worker (lock interno).

### Graph API version

Constante `GRAPH_API_VERSION` en `src/whatsapp/graph-api.constants.ts`,
hoy con placeholder `vXX.X` — **confirmar contra el changelog de Meta antes
del primer llamado real**. Todas las URLs se construyen desde ahí.

## Row-Level Security (preparado, no activado)

El diseño completo está en `prisma/rls/rls_policies.draft.sql` (draft
comentado, fuera de `prisma/migrations` para que no se aplique).

Lo que ya está en su lugar desde el día uno:

- La app se conecta con **`app_user`**: no superusuario, sin `BYPASSRLS`
  (los superusuarios saltean RLS silenciosamente). Se crea en
  `docker/postgres/init/01-roles.sql`. Tiene `CREATEDB` solo para la shadow
  database de `prisma migrate dev`.
- En dev `app_user` es también **owner** de las tablas (corre las
  migraciones), y el owner saltea RLS salvo `FORCE ROW LEVEL SECURITY` —
  por eso el draft lo incluye en cada tabla. En producción, la alternativa
  más limpia es separar el rol de migraciones (owner) del rol de runtime.

### Restricción de pooling (decisión pendiente al deployar)

RLS depende de `current_setting('app.tenant_id')`, que la app debe setear
**por transacción** con `SET LOCAL` dentro de la transacción que hace la
query. Consecuencia para el pooler:

- **PgBouncer en `transaction` mode**: un `SET` de sesión se filtra entre
  tenants que comparten la conexión — inaceptable. Solo sirve `SET LOCAL`
  por transacción, lo que obliga a envolver cada unidad de trabajo en una
  transacción explícita.
- **Session pooling** (o conexión directa): permite `SET` de sesión, a
  costa de más conexiones.

La decisión de pooler se toma al llegar al deploy; esto solo documenta la
restricción para que no sorprenda.

## Layout

```
prisma/
  schema.prisma            # modelo completo (ver comentarios por decisión)
  seed.ts                  # Nova Sushi + MetaApp + cuenta WA (cifradas)
  rls/rls_policies.draft.sql
src/
  crypto/                  # AES-256-GCM envelope versionado
  prisma/                  # PrismaService.db + tenant-guard + soft-delete
  retention/               # purgeContact / purgeWebhookEvents + MediaStorage
  whatsapp/                # GRAPH_API_VERSION (placeholder)
docker/postgres/init/      # rol app_user (no superuser) + DB
```

## Fases

1. ✅ Esquema + migración + cifrado + seed + guard multi-tenant
2. ✅ Webhook: GET verify, firma HMAC sobre raw body, encolado, 200 < 5s
3. ✅ Worker BullMQ: parseo, resolución de tenant por `phone_number_id`,
   idempotencia por wamid, statuses + pricing, job de purga
4. ⬜ Envío + ventana de 24h (`isWindowOpen`, 131047/131026/130429)
5. ⬜ Media entrante → R2 (+ `R2MediaStorage` para retención)
6. ⬜ Gateway WebSocket
7. ⬜ Frontend Next.js (3 columnas, tablet-first)
