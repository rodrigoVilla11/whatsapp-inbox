# Integración con GOURMETIFY

El inbox vive bajo el dominio de Gourmetify en el path `/inbox` (sin iframe,
sin CORS: mismo origen). Este doc es el contrato completo — lo que se toca en
Gourmetify es UNA cosa: los links.

## 1. Reemplazo de la redirección a WhatsApp Web

Donde Gourmetify hoy genera:

```
https://wa.me/<telefono>?text=<mensaje-urlencoded>
```

pasa a generar (mismos valores, solo cambia host y path):

```
https://<dominio-gourmetify>/inbox/whatsapp?phone=<telefono>&text=<mensaje-urlencoded>
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

## 2. Ruteo en Easypanel (dominio de Gourmetify)

Dos reglas nuevas, cada una creada DENTRO del servicio del inbox
correspondiente (el destino siempre es el contenedor del servicio dueño de
la regla):

| Servicio | Host | Ruta | Destino puerto | Destino Ruta |
|---|---|---|---|---|
| `inbox-api` | `<dominio-gourmetify>` | `/inbox/api` | `3001` | `/api` |
| `inbox-web` | `<dominio-gourmetify>` | `/inbox` | `3000` | `/inbox` |

- El path más largo gana: `/inbox/api/*` va a la API (reescrito a `/api/*`),
  el resto de `/inbox/*` al Next (que sirve con `basePath: '/inbox'`).
- El WebSocket entra por `/inbox/api/socket.io` y el rewrite lo lleva al
  path real del gateway — Traefik maneja el upgrade con la misma regla.
- Las reglas existentes de Gourmetify (su `/`, su propio `/api`, etc.) no se
  tocan: `/inbox*` es un prefijo nuevo que no colisiona.

## 3. URLs resultantes

- Inbox: `https://<dominio>/inbox` (lista), `/inbox/c/<id>` (hilo),
  `/inbox/login`, `/inbox/settings`.
- API/healthcheck: `https://<dominio>/inbox/api/health/ready`.
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
