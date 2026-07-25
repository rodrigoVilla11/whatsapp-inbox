/**
 * Presentación de la ventana de 24h a partir de LO QUE MANDA EL SERVIDOR
 * (isWindowOpen + windowExpiresAt). Regla: la UI jamás decide con
 * lastInboundAt y su propio reloj — la tablet puede tener la hora corrida.
 * El countdown es cosmético; el modo lo fija el server.
 */

export const EXPIRING_THRESHOLD_MS = 2 * 60 * 60 * 1000; // < 2h → aviso

export type WindowMode = 'open' | 'expiring' | 'closed';

export interface WindowView {
  mode: WindowMode;
  /** ms restantes (cosmético). null si no aplica. */
  msLeft: number | null;
}

export function windowView(
  conversation: { isWindowOpen: boolean; windowExpiresAt: string | null },
  now: number = Date.now(),
): WindowView {
  // El server manda: cerrada es cerrada (incluye el rebobinado del 131047).
  if (!conversation.isWindowOpen) return { mode: 'closed', msLeft: null };

  const expiresAt = conversation.windowExpiresAt
    ? Date.parse(conversation.windowExpiresAt)
    : null;
  if (expiresAt === null) return { mode: 'open', msLeft: null };

  const msLeft = expiresAt - now;
  // El reloj local dice vencida pero el server aún dice abierta: se muestra
  // "por vencer" en 0 — el input sigue habilitado; si el envío choca, el
  // 131047 de fase 4 corrige al server y llega conversation.updated.
  if (msLeft <= EXPIRING_THRESHOLD_MS) return { mode: 'expiring', msLeft: Math.max(0, msLeft) };
  return { mode: 'open', msLeft };
}

/** "1h 23m" / "23m" / "<1m" — para el countdown del banner y la lista. */
export function formatCountdown(msLeft: number): string {
  const totalMinutes = Math.floor(msLeft / 60_000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
