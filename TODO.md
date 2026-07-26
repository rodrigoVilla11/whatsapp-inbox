# TODO — pendientes conscientes

## Deploy

Los pendientes de productivización de fase 8 se implementaron en fase 10
(healthchecks, graceful shutdown, pino, trust proxy, rate limit en Redis,
barrido de sesiones, validación de env). Ver DEPLOY.md. Queda anotado:

- **Meta App de test separada para dev** — si el cutover del webhook a
  producción vuelve friccioso el dev local (túnel + cambiar la Callback
  URL cada vez), crear una app de test con su propio número de prueba
  apuntando al túnel. Opción documentada en DEPLOY.md §5, no implementada.
- **Réplicas de la API** — hoy: 1 instancia. Antes de escalar: mover
  `prisma migrate deploy` del entrypoint a un job de release, y revisar
  sticky sessions para el polling de socket.io (con websocket-only no
  hace falta).

## Tier 2 del inbox (fuera de la fase 9 a propósito)

Cada ítem quedó afuera por una razón concreta; ninguno bloquea que la cajera
opere hoy. El orden es una sugerencia de prioridad para cuando toque.

- **Búsqueda dentro de mensajes (full-text)** — la búsqueda por contacto ya
  resuelve el caso del mostrador ("¿qué me pidió María?" se responde abriendo
  el hilo). Requeriría: `tsvector` + índice GIN sobre `Message.body` (con
  configuración `spanish`), endpoint de búsqueda con highlight y una UI de
  resultados dentro del hilo (saltar al mensaje + contexto).

- **Dark mode** — la tablet del mostrador opera de día con brillo alto; el
  beneficio real es para el dueño de noche, y es un solo usuario. Requeriría:
  segunda capa de tokens (`--core-*` en `prefers-color-scheme: dark`),
  auditoría de contraste AA completa de nuevo, y decidir si es preferencia
  de dispositivo o del sistema.

- **Virtualización de listas largas** — con paginado de 30/50 y un
  restaurante real (decenas de conversaciones, no miles), el DOM aguanta
  sobrado. Requeriría: `content-visibility` o una virtualización manual
  (sin dependencias de 30kb), y re-resolver el scroll-preservation del
  prepend sobre items virtualizados — justo lo más delicado del hilo.

- **Presencia multi-agente ("X está escribiendo/viendo")** — hoy el equipo
  es la cajera + el dueño; la asignación ya evita respuestas dobles.
  Requeriría: canal WS de presencia efímera (typing con TTL en Redis),
  throttling de eventos y UI en lista + hilo.

- **Etiquetas de conversación** — sin volumen real todavía no se sabe qué
  etiquetas sirven (¿pedido? ¿reclamo? ¿mayorista?). Requeriría: modelo
  `Tag` + M2M con tenant scoping, CRUD en ajustes, chips en fila/hilo y
  filtro por etiqueta en la lista.

- **Snooze / recordatorios** — pospone conversaciones ("recordame a las 19");
  útil pero pide infraestructura de jobs con hora local del tenant.
  Requeriría: campo `snoozedUntil`, un scheduler (el worker ya existe, falta
  el cron), filtro en lista y notificación al despertar.

- **Métricas de tiempos de respuesta** — es una vista para el dueño, no una
  herramienta del mostrador; primero juntar semanas de datos reales.
  Requeriría: agregación por conversación (primer respuesta, promedio por
  franja), endpoint de reporting y una página nueva con visualizaciones.
