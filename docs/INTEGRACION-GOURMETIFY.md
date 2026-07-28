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

## 4. Pendiente para después (anotado, no implementado)

- **SSO**: hoy la cajera se loguea una vez en el inbox (cookie 30 días).
  El gancho `User.gourmetifyUserId` ya existe para que, cuando se quiera,
  un usuario logueado en Gourmetify entre sin segundo login.
- **Vincular datos**: `Contact.customerId` y `Conversation.orderId` están en
  el schema esperando el cruce con clientes/pedidos de Gourmetify.
