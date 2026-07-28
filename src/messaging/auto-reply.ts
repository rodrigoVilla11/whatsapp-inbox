/**
 * Auto-respuesta fuera de horario — lógica PURA (sin Nest ni Prisma):
 * parseo/validación de la config y el cálculo de "¿está abierto?" en el
 * TIMEZONE DEL TENANT, con soporte de dos turnos por día y rangos que
 * cruzan medianoche (19:30–00:30 es la norma gastronómica, no la excepción).
 */

export interface TimeRange {
  /** "HH:MM" en hora local del tenant. */
  from: string;
  to: string;
}

/** Claves '0' (domingo) … '6' (sábado). Día ausente o [] = cerrado. */
export type WeekSchedule = Record<string, TimeRange[]>;

export interface AutoReplyConfig {
  enabled: boolean;
  message: string;
  schedule: WeekSchedule;
}

export const MAX_RANGES_PER_DAY = 2;
export const MAX_MESSAGE_LENGTH = 1000;
export const AUTO_REPLY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // máx 1 cada 6h

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Valida una config cruda. Devuelve la config normalizada o una lista de
 * problemas (para el 400 del PUT).
 */
export function parseAutoReplyConfig(
  raw: unknown,
): { ok: true; config: AutoReplyConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['la configuración debe ser un objeto'] };
  }
  const data = raw as Record<string, unknown>;

  const enabled = data.enabled === true;
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  if (enabled && !message) problems.push('el mensaje no puede estar vacío si está activada');
  if (message.length > MAX_MESSAGE_LENGTH) {
    problems.push(`el mensaje supera los ${MAX_MESSAGE_LENGTH} caracteres`);
  }

  const schedule: WeekSchedule = {};
  const rawSchedule =
    typeof data.schedule === 'object' && data.schedule !== null && !Array.isArray(data.schedule)
      ? (data.schedule as Record<string, unknown>)
      : {};
  for (let day = 0; day <= 6; day++) {
    const key = String(day);
    const rawRanges = rawSchedule[key];
    if (rawRanges === undefined || rawRanges === null) {
      schedule[key] = [];
      continue;
    }
    if (!Array.isArray(rawRanges)) {
      problems.push(`día ${key}: se espera una lista de rangos`);
      continue;
    }
    if (rawRanges.length > MAX_RANGES_PER_DAY) {
      problems.push(`día ${key}: máximo ${MAX_RANGES_PER_DAY} rangos`);
      continue;
    }
    const ranges: TimeRange[] = [];
    for (const rawRange of rawRanges) {
      const r = rawRange as { from?: unknown; to?: unknown };
      if (typeof r?.from !== 'string' || typeof r?.to !== 'string') {
        problems.push(`día ${key}: rango sin from/to`);
        continue;
      }
      if (!TIME_RE.test(r.from) || !TIME_RE.test(r.to)) {
        problems.push(`día ${key}: horas en formato HH:MM (recibido "${r.from}–${r.to}")`);
        continue;
      }
      if (r.from === r.to) {
        problems.push(`día ${key}: el rango ${r.from}–${r.to} no dura nada`);
        continue;
      }
      ranges.push({ from: r.from, to: r.to });
    }
    schedule[key] = ranges;
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { enabled, message, schedule } };
}

/** Día de semana (0=Dom..6=Sáb) y minutos del día, EN el timezone dado. */
function localParts(date: Date, timezone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayIndex: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  // Intl puede devolver "24" para medianoche según ICU: normalizar a 0.
  const hour = Number(get('hour')) % 24;
  return { weekday: weekdayIndex[get('weekday')] ?? 0, minutes: hour * 60 + Number(get('minute')) };
}

/**
 * ¿El restaurante está abierto en `date`? Un rango con to < from cruza
 * medianoche: cubre desde `from` hasta 24:00 de SU día, y de 00:00 a `to`
 * del día SIGUIENTE.
 */
export function isOpenAt(schedule: WeekSchedule, date: Date, timezone: string): boolean {
  const { weekday, minutes } = localParts(date, timezone);

  for (const range of schedule[String(weekday)] ?? []) {
    const from = toMinutes(range.from);
    const to = toMinutes(range.to);
    if (from < to) {
      if (minutes >= from && minutes < to) return true;
    } else if (minutes >= from) {
      return true; // tramo nocturno del propio día (19:30 → 24:00)
    }
  }

  // Tramo post-medianoche de un rango del día ANTERIOR (…00:00 → 00:30).
  const previous = (weekday + 6) % 7;
  for (const range of schedule[String(previous)] ?? []) {
    const from = toMinutes(range.from);
    const to = toMinutes(range.to);
    if (from > to && minutes < to) return true;
  }

  return false;
}
