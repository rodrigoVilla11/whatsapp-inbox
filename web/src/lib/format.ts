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
