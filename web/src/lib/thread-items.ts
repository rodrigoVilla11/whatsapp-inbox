import { formatDay } from './format';
import type { Message } from './types';

/**
 * Agrupación PURA del hilo (sin React): separadores de día + burbujas
 * consecutivas del mismo autor colapsadas en un grupo. La metadata
 * (hora + tildes) se muestra solo en la ÚLTIMA burbuja del grupo.
 */

/** Gap máximo entre mensajes del mismo autor para seguir en el grupo. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type ThreadItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; message: Message; first: boolean; last: boolean };

function dayKeyOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone: timezone }).format(
    new Date(iso),
  );
}

/**
 * "Hoy" / "Ayer" / fecha corta, en el timezone del tenant.
 * now=null (SSR / primer paint del cliente): SIEMPRE la fecha absoluta —
 * "Hoy" depende del reloj y rompería la hydration.
 */
export function dayLabel(iso: string, timezone: string, now: Date | null = new Date()): string {
  if (now === null) return formatDay(iso, timezone);
  const key = dayKeyOf(iso, timezone);
  if (key === dayKeyOf(now.toISOString(), timezone)) return 'Hoy';
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  if (key === dayKeyOf(yesterday.toISOString(), timezone)) return 'Ayer';
  return formatDay(iso, timezone);
}

/**
 * messages: ascendentes por timestamp y SIN reacciones (el caller ya las
 * colgó de sus burbujas). El separador de día también corta el grupo.
 */
export function buildThreadItems(
  messages: readonly Message[],
  timezone: string,
  now: Date | null = new Date(),
): ThreadItem[] {
  const items: ThreadItem[] = [];
  let prev: Message | null = null;

  for (const message of messages) {
    const key = dayKeyOf(message.timestamp, timezone);
    const newDay = prev === null || dayKeyOf(prev.timestamp, timezone) !== key;
    if (newDay) {
      items.push({ kind: 'day', key: `day-${key}`, label: dayLabel(message.timestamp, timezone, now) });
    }

    const grouped =
      prev !== null &&
      !newDay &&
      prev.direction === message.direction &&
      Date.parse(message.timestamp) - Date.parse(prev.timestamp) <= GROUP_WINDOW_MS;

    if (grouped) {
      (items[items.length - 1] as { kind: 'message'; last: boolean }).last = false;
      items.push({ kind: 'message', message, first: false, last: true });
    } else {
      items.push({ kind: 'message', message, first: true, last: true });
    }
    prev = message;
  }
  return items;
}
