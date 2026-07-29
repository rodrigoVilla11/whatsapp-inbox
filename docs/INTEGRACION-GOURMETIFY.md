# Integración con GOURMETIFY

El inbox vive en `https://inbox.gourmetify.pro/inbox` (host propio + path
`/inbox`; sin iframe, sin CORS). Este doc es el contrato completo — lo que
se toca en Gourmetify es UNA cosa: los links.

> Nota de por qué subdominio y no `gourmetify.pro/inbox`: el Traefik de este
> Easypanel no respeta reglas por path cuando el host está declarado en un
> servicio de OTRO proyecto (verificado empíricamente — hasta un path de
> prueba caía en la app de Gourmetify). Con host propio no hay conflicto.

## 1. Reemplazo de la redirección a WhatsApp Web

Donde Gourmetify hoy genera:

```
https://wa.me/<telefono>?text=<mensaje-urlencoded>
```

pasa a generar (mismos valores, solo cambia host y path):

```
https://inbox.gourmetify.pro/inbox/whatsapp?phone=<telefono>&text=<mensaje-urlencoded>
```

- `phone`: dígitos internacionales sin `+` (formato wa.me tal cual:
  `5493415551234`). El inbox tolera `+`, espacios y guiones igual.
- `text`: opcional, urlencoded — queda precargado en el composer.
- Comportamiento: abre la conversación de ese teléfono (la crea si es un
  cliente nuevo). Si la cajera no tiene sesión, pasa por el login y vuelve
  al mismo destino. Si la ventana de 24h está cerrada, el texto queda a la
  vista pero solo se puede enviar plantilla (regla de Meta, no un bug).
- `target="_blank"` o misma pestaña: decisión de UX de Gourmetify, ambas
  funcionan.

## 2. DNS + ruteo en Easypanel

**DNS** (zona de `gourmetify.pro`): registro **A** `inbox` → IP del VPS
(`72.60.240.232`). Sin proxy intermedio.

**Reglas** — cada una creada DENTRO del servicio del inbox correspondiente,
destino siempre con protocolo **HTTP** (el TLS público lo maneja el proxy):

| Servicio | Host | Ruta | Destino puerto | Destino Ruta |
|---|---|---|---|---|
| `inbox-api` | `inbox.gourmetify.pro` | `/inbox/api` | `3001` | `/api` |
| `inbox-web` | `inbox.gourmetify.pro` | `/inbox` | `3000` | `/inbox` |

- El path más largo gana: `/inbox/api/*` va a la API (reescrito a `/api/*`),
  el resto de `/inbox/*` al Next (que sirve con `basePath: '/inbox'`).
- El WebSocket entra por `/inbox/api/socket.io` y el rewrite lo lleva al
  path real del gateway — Traefik maneja el upgrade con la misma regla.
- El certificado Let's Encrypt del subdominio lo emite Easypanel solo, una
  vez que el DNS resuelve.

## 3. URLs resultantes

- Inbox: `https://inbox.gourmetify.pro/inbox` (lista), `/inbox/c/<id>`
  (hilo), `/inbox/login`, `/inbox/settings`.
- API/healthcheck: `https://inbox.gourmetify.pro/inbox/api/health/ready`.
- Webhook de Meta: **sin cambios** — sigue en el host original
  (`https://<subdominio-actual>/api/webhooks/whatsapp`); no pasa por el
  frontend ni por el dominio de Gourmetify. Migrarlo al dominio final es
  opcional (un solo cambio de Callback URL en el panel de Meta cuando se
  quiera).

## 4. API de provisioning (Gourmetify → inbox, servicio-a-servicio)

Para que cada cliente de Gourmetify tenga su tenant y conecte SU WhatsApp
con credenciales propias (puente hasta que Meta apruebe el Embedded
Signup). Auth: header `x-provisioning-key: <PROVISIONING_SECRET>` (misma
env en ambos backends; sin ella los endpoints dan 503). Base:
`https://inbox.gourmetify.pro/inbox/api`.

### 4.1 Alta de tenant (idempotente por `gourmetifyTenantId`)

```
POST /provisioning/tenants
{
  "gourmetifyTenantId": "<id del cliente en Gourmetify>",
  "name": "La Parrilla de Ana",
  "timezone": "Europe/Madrid",            // opcional
  "owner": {
    "email": "ana@parrilla.es",
    "name": "Ana",
    "password": "opcional-min-10"          // si falta, se genera
  }
}
→ 201 { created, tenant: {id, slug, name, timezone, gourmetifyTenantId},
        owner: { email, name, initialPassword? } }
```

- `initialPassword` viene SOLO si se generó, SOLO en esta respuesta:
  Gourmetify se la muestra al dueño una única vez. El primer login fuerza
  el cambio.
- Repetir el POST con el mismo `gourmetifyTenantId` actualiza nombre/tz y
  devuelve `created: false` — seguro para retries.

### 4.2 Conectar WhatsApp del cliente

El cliente (guiado por la UI de Gourmetify) crea su app en Meta y junta:
App ID, App Secret, Phone Number ID, WABA ID y un access token de system
user (permanente, permisos `whatsapp_business_messaging` +
`whatsapp_business_management`).

```
PUT /provisioning/tenants/<gourmetifyTenantId>/whatsapp
{
  "metaAppId": "…", "metaAppSecret": "…",
  "phoneNumberId": "…", "wabaId": "…",
  "accessToken": "…",
  "displayPhone": "+34 …",                // opcional (se toma de Meta)
  "verifyToken": "…"                      // opcional (se genera)
}
→ 200 { connected: true, tenant, account: {phoneNumberId, wabaId,
        displayPhoneNumber, status}, webhook: { path, url, verifyToken } }
```

- **Valida EN VIVO contra Graph API antes de guardar**: token vencido o
  phone_number_id ajeno → 400 con el mensaje de Meta textual.
- Los secretos se cifran (AES-GCM) y **jamás vuelven en una respuesta**.
- **La App de Meta se comparte** entre tenants (modelo Tech Provider: una
  app, N números; el webhook resuelve el tenant por `phone_number_id`). Lo
  exclusivo es el NÚMERO: conectarlo a otro restaurante da 409.
- **Cambiar de número** (típico: prueba → real) es repetir el PUT con el
  `phoneNumberId` nuevo: el anterior del mismo tenant queda `DISCONNECTED`
  (su historial se conserva) y la respuesta trae `replacedNumbers: 1`.
- `webhook.url` + `webhook.verifyToken` son lo que el cliente pega en su
  panel de Meta (Callback URL propia por cliente: `/webhooks/whatsapp/<ref>`
  — la firma se valida con SU app secret). Requiere `PUBLIC_API_URL` en el
  env de la API para armar la URL absoluta.
- 409: número ya conectado a otro restaurante, o App ID en uso por otro.
- Re-ejecutar actualiza credenciales (rotación de token = repetir el PUT).

### 4.3 Estado

```
GET /provisioning/tenants/<gourmetifyTenantId>/whatsapp
→ { connected: false, tenant } | mismo shape que 4.2 (sin secretos)

GET /provisioning/tenants
→ [{ id, slug, name, timezone, gourmetifyTenantId, linkedToGourmetify,
     whatsapp: { phoneNumberId, displayPhoneNumber, status } | null,
     hasConversations }]   ← diagnóstico: qué tenants hay y cómo están
```

### 4.4 Restaurante que YA usaba el inbox (adopción)

Si el restaurante ya tenía tenant en el inbox (por ejemplo el del seed) y
ahora se conecta desde Gourmetify, **no hay que crear uno nuevo**: sus
credenciales de Meta ya están atadas al tenant viejo y conectar el mismo
número a otro tenant devuelve 409. Se adopta:

```
POST /provisioning/tenants
{ "gourmetifyTenantId": "...", "name": "...", "adoptSlug": "nova-sushi" }
→ 201 { created: false, adopted: true, tenant, owner }
```

- Conserva conversaciones, contactos y usuarios del tenant adoptado.
- Si otro tenant VACÍO estaba ocupando ese `gourmetifyTenantId` (un intento
  anterior), se libera solo; si tenía datos → 409 para que decida una
  persona.
- Después, el PUT de 4.2 con las mismas credenciales funciona: la MetaApp
  existente se REUSA (mismo `ref` → la Callback URL ya configurada en Meta
  sigue válida) y el verify token **no se regenera** salvo que se mande uno.

### 4.4 Checklist que la UI de Gourmetify le muestra al cliente

1. Crear app en developers.facebook.com (tipo Business) y agregar el
   producto WhatsApp.
2. Anotar App ID y App Secret (Configuración → Básica).
3. En WhatsApp → API Setup: anotar Phone Number ID y WABA ID.
4. Crear un System User en Business Manager con la app y la WABA como
   activos, y generar token SIN vencimiento con los dos permisos de
   WhatsApp.
5. Pegar todo en el formulario de Gourmetify (que llama al PUT 4.2).
6. Con la respuesta: pegar Callback URL + verify token en la config del
   webhook de su app en Meta y suscribirse al campo `messages`.

## 5. Pedidos en el chat (webhook Gourmetify → inbox)

La cajera ve el pedido del cliente y su estado EN VIVO al lado del chat.
Modelo push: Gourmetify avisa al inbox al **crear un pedido y en cada
cambio de estado**. Mismo auth que el provisioning (`x-provisioning-key`).

```
POST /gourmetify/orders
{
  "gourmetifyTenantId": "<id del cliente en Gourmetify>",
  "order": {
    "id": "<id único del pedido en Gourmetify>",
    "number": "123",                        // opcional, display
    "customerPhone": "5493415551234",       // dígitos internacionales
    "statusLabel": "En preparación",        // texto listo para mostrar
    "statusKind": "in_progress",            // pending|in_progress|ready|done|cancelled
    "summary": "2x Roll Nova, 1x Sésamo",   // opcional, display
    "totalLabel": "$ 18.500",               // opcional, display
    "deliveryLabel": "Retiro en local",     // opcional, display
    "scheduledLabel": "Retira 21:30",       // opcional, display
    "createdAt": "2026-07-28T20:00:00Z"     // ISO, para ordenar
  }
}
→ 200 { ok: true, order: {...} }
```

Reglas:
- **Display-ready**: los `*Label` se muestran tal cual (moneda, idioma y
  formato los decide Gourmetify). `statusKind` es lo ÚNICO que el inbox
  interpreta (color del chip y partición activo/cerrado).
- **Idempotente** por `(gourmetifyTenantId, order.id)`: reintentos y
  actualizaciones de estado repiten el mismo POST con el estado nuevo.
- **Best-effort con 1 retry**: si el inbox no responde, loguear y seguir —
  el flujo de pedidos de Gourmetify JAMÁS se frena por esto. El inbox se
  pone al día con el próximo estado.
- Solo para restaurantes con el inbox habilitado (mismo flag del §
  redirección condicional).
- Errores: 404 tenant desconocido, 400 con detalle (statusKind inválido,
  fechas mal formadas).

## 6. Pendiente para después (anotado, no implementado)

- **SSO**: hoy la cajera se loguea una vez en el inbox (cookie 30 días).
  El gancho `User.gourmetifyUserId` ya existe para que, cuando se quiera,
  un usuario logueado en Gourmetify entre sin segundo login.
- **Vincular datos**: `Contact.customerId` y `Conversation.orderId` están en
  el schema esperando el cruce con clientes/pedidos de Gourmetify.
