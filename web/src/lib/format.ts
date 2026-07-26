/** Formateo de fechas EN EL TIMEZONE DEL TENANT (viene del backend). */

export function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(iso));
}

export function formatDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));
}

/** Hora si es de hoy (en el TZ del tenant), fecha corta si no. */
export function listTimestamp(iso: string, timezone: string, now: Date = new Date()): string {
  const sameDay =
    new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone: timezone }).format(
      new Date(iso),
    ) ===
    new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone: timezone }).format(now);
  return sameDay ? formatTime(iso, timezone) : formatDay(iso, timezone);
}

/**
 * Hora relativa "inteligente" de la lista: "ahora", "5 min", "18:31" (hoy),
 * "ayer", "vie" (últimos 7 días), "26/07" (más viejo). Timezone del tenant.
 */
export function relativeListTime(iso: string, timezone: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'ahora'; // incluye relojes corridos (diff negativo)
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min`;

  const dayOf = (d: Date): string =>
    new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone: timezone }).format(d);
  const then = new Date(iso);
  if (dayOf(then) === dayOf(now)) return formatTime(iso, timezone);
  if (dayOf(then) === dayOf(new Date(now.getTime() - 86_400_000))) return 'ayer';
  if (diffMs < 7 * 86_400_000) {
    return new Intl.DateTimeFormat('es-AR', { weekday: 'short', timeZone: timezone })
      .format(then)
      .replace('.', '');
  }
  return formatDay(iso, timezone);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initialOf(name: string | null, fallback: string): string {
  const source = (name ?? fallback).trim();
  return source ? source[0].toUpperCase() : '?';
}
