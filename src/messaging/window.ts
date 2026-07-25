import type { Conversation } from '@prisma/client';

/**
 * Ventana de servicio de 24 horas de WhatsApp.
 *
 * La fuente de verdad local es Conversation.lastInboundAt (lo mantiene el
 * worker con cada mensaje entrante). La fuente de verdad REAL es Meta: si
 * un envío devuelve 131047, Meta gana y la conversación se corrige en el
 * acto (ver expiredLastInboundAt).
 */
export const SERVICE_WINDOW_HOURS = 24;
const SERVICE_WINDOW_MS = SERVICE_WINDOW_HOURS * 60 * 60 * 1000;

type WindowSource = Pick<Conversation, 'lastInboundAt'>;

/** Cuándo vence la ventana — la UI lo muestra cuando quedan < 2h. */
export function windowExpiresAt(conversation: WindowSource): Date | null {
  if (!conversation.lastInboundAt) return null;
  return new Date(conversation.lastInboundAt.getTime() + SERVICE_WINDOW_MS);
}

export function isWindowOpen(conversation: WindowSource, now: Date = new Date()): boolean {
  const expiresAt = windowExpiresAt(conversation);
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}

/**
 * Mecanismo de auto-corrección ante 131047 (elegido y documentado):
 * se REBOBINA lastInboundAt a exactamente `now - 24h`, con lo cual
 * isWindowOpen pasa a false de inmediato y la UI cae a modo plantilla.
 *
 * Por qué rebobinar el campo y no un flag aparte: lastInboundAt tiene un
 * único consumidor (esta ventana), no requiere migración, y el historial
 * real de entrantes sigue íntegro en Message.timestamp. Si después llega
 * un entrante nuevo, la guarda monotónica del worker (lte) lo avanza sin
 * conflicto porque el valor rebobinado siempre es más viejo.
 */
export function expiredLastInboundAt(now: Date = new Date()): Date {
  return new Date(now.getTime() - SERVICE_WINDOW_MS);
}
