/**
 * Máquina de estados PURA del envío (contrato de fases 4/6):
 *
 * - startSend: clientDedupKey NUEVA (UUID v4 al momento del primer intento).
 * - fallo de RED/timeout → reintento con la MISMA key (el backend dedupea:
 *   si el primer intento llegó, devuelve ese mensaje; si no, envía).
 *   Un (1) auto-retry; después queda 'failed-network' con retry manual,
 *   también MISMA key — nunca hubo un FAILED persistido.
 * - respuesta del servidor con Message FAILED → 'failed-domain'. El botón
 *   "reintentar" acá es un envío NUEVO por decisión humana → key NUEVA
 *   (reusar la key devolvería el mismo fallo cacheado para siempre).
 */

export type OutboxStatus = 'sending' | 'failed-network' | 'failed-domain';

export interface OutboxEntry {
  clientDedupKey: string;
  attempts: number;
  status: OutboxStatus;
}

export const defaultKeyGen = (): string => crypto.randomUUID();

export function startSend(gen: () => string = defaultKeyGen): OutboxEntry {
  return { clientDedupKey: gen(), attempts: 1, status: 'sending' };
}

/** Fallo de red: MISMA key. */
export function onNetworkError(entry: OutboxEntry): OutboxEntry {
  return { ...entry, status: 'failed-network' };
}

/** ¿Corresponde el único auto-retry (misma key)? */
export function shouldAutoRetry(entry: OutboxEntry): boolean {
  return entry.attempts < 2;
}

export function nextNetworkAttempt(entry: OutboxEntry): OutboxEntry {
  return { clientDedupKey: entry.clientDedupKey, attempts: entry.attempts + 1, status: 'sending' };
}

/** El servidor persistió un FAILED (error de dominio). */
export function onDomainFailure(entry: OutboxEntry): OutboxEntry {
  return { ...entry, status: 'failed-domain' };
}

/**
 * Reintento MANUAL:
 * - failed-network → misma key (sigue siendo el mismo envío).
 * - failed-domain  → key NUEVA (envío nuevo por decisión humana).
 */
export function manualRetry(entry: OutboxEntry, gen: () => string = defaultKeyGen): OutboxEntry {
  if (entry.status === 'failed-domain') {
    return { clientDedupKey: gen(), attempts: 1, status: 'sending' };
  }
  return { clientDedupKey: entry.clientDedupKey, attempts: entry.attempts + 1, status: 'sending' };
}
