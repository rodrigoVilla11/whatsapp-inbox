/**
 * Eventos de dominio para tiempo real.
 *
 * REGLA CENTRAL: los servicios de dominio NO hablan con el gateway.
 * Publican al canal de Redis y el gateway (suscripto) reenvía a los
 * sockets. Hoy API y workers conviven en un proceso; el día que el worker
 * vaya a otro contenedor o haya dos réplicas de la API, esto ya funciona —
 * separar procesos es un cambio de deploy, no de código.
 *
 * Canal: UNO global con tenantId en el sobre (elegido sobre canal-por-
 * tenant: cero gestión dinámica de suscripciones; el gateway rutea por
 * sobre al room del tenant).
 */

export const DOMAIN_EVENTS_CHANNEL = 'domain-events';

export type DomainEventType =
  | 'message.created'
  | 'message.updated'
  | 'conversation.updated'
  | 'order.updated';

/** Sobre que viaja por Redis. occurredAt lo estampa el publisher. */
export interface DomainEvent<T = unknown> {
  tenantId: string;
  type: DomainEventType;
  payload: T;
  occurredAt: string; // ISO-8601
}

// ── Payloads (contrato de la fase 7) ────────────────────────────────────

/** Mensaje nuevo (entrante del worker o saliente recién creado del envío). */
export interface MessageCreatedPayload {
  conversationId: string;
  /** Message de Prisma serializado (Dates → ISO). */
  message: Record<string, unknown>;
}

/**
 * Cambio parcial de un mensaje: statuses (sent/delivered/read/failed) y
 * media (DOWNLOADED/FAILED). `changes` trae SOLO los campos cambiados con
 * su valor actual — la UI mergea sobre el mensaje que ya tiene.
 */
export interface MessageUpdatedPayload {
  id: string;
  conversationId: string;
  changes: Record<string, unknown>;
}

/** Estado completo de la conversación (la UI reemplaza, no mergea). */
export interface ConversationUpdatedPayload {
  conversation: Record<string, unknown>;
}

/** Pedido de Gourmetify creado/actualizado (la UI upsertea por id). */
export interface OrderUpdatedPayload {
  order: Record<string, unknown>;
  contactId: string | null;
}

// ── Publisher ───────────────────────────────────────────────────────────

export interface DomainEventPublisher {
  /**
   * Best-effort: implementaciones loguean y tragan errores — el WS es
   * secundario, la fuente de verdad es la API REST (contrato de
   * reconexión: refetch por REST y recién después confiar en el stream).
   */
  publish(event: Omit<DomainEvent, 'occurredAt'>): Promise<void>;
}

export const DOMAIN_EVENT_PUBLISHER = Symbol('DOMAIN_EVENT_PUBLISHER');

/** Room de socket.io por tenant. El tenant sale del handshake, jamás del cliente. */
export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}
