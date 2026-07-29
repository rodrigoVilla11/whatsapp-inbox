/** Formateo de fechas EN EL TIMEZONE DEL TENANT (viene del backend). */

/**
 * Intl.format() TIRA RangeError con una fecha inválida, y estos formateadores
 * corren en render: un throw acá se lleva la pantalla entera (no hay error
 * boundary). Una fecha inválida es un bug de datos aguas arriba — que se vea
 * como un hueco, no como un crash.
 */
function validDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(iso: string, timezone: string): string {
  const date = validDate(iso);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

export function formatDay(iso: string, timezone: string): string {
  const date = validDate(iso);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
  }).format(date);
}

/** Hora si es de hoy (en el TZ del tenant), fecha corta si no. */
export function listTimestamp(iso: string, timezone: string, now: Date = new Date()): string {
  if (!validDate(iso)) return '';
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
  if (!validDate(iso)) return '';
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
