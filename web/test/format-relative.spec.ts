import { describe, expect, it } from 'vitest';
import { relativeListTime } from '../src/lib/format';

/** Hora relativa de la lista (9b) — todo en el timezone del tenant. */

const TZ = 'UTC';
// domingo 26/07/2026 18:00 UTC
const NOW = new Date('2026-07-26T18:00:00Z');

describe('relativeListTime', () => {
  it('menos de 1 minuto → "ahora" (incluye reloj corrido hacia el futuro)', () => {
    expect(relativeListTime('2026-07-26T17:59:30Z', TZ, NOW)).toBe('ahora');
    expect(relativeListTime('2026-07-26T18:05:00Z', TZ, NOW)).toBe('ahora'); // futuro
  });

  it('menos de 1 hora → minutos', () => {
    expect(relativeListTime('2026-07-26T17:55:00Z', TZ, NOW)).toBe('5 min');
    expect(relativeListTime('2026-07-26T17:01:00Z', TZ, NOW)).toBe('59 min');
  });

  it('mismo día → hora exacta', () => {
    expect(relativeListTime('2026-07-26T12:31:00Z', TZ, NOW)).toBe('12:31');
  });

  it('día anterior → "ayer"', () => {
    expect(relativeListTime('2026-07-25T23:59:00Z', TZ, NOW)).toBe('ayer');
    expect(relativeListTime('2026-07-25T01:00:00Z', TZ, NOW)).toBe('ayer');
  });

  it('últimos 7 días → día de la semana corto', () => {
    // viernes 24/07
    expect(relativeListTime('2026-07-24T10:00:00Z', TZ, NOW)).toBe('vie');
  });

  it('más viejo → fecha corta día/mes', () => {
    // el padding del mes depende del ICU (10/07 o 10/7) — el contrato es d/m
    expect(relativeListTime('2026-07-10T10:00:00Z', TZ, NOW)).toMatch(/^10\/0?7$/);
  });

  it('respeta el timezone del tenant para el corte de día', () => {
    // 2026-07-26 01:00 UTC = 25/07 22:00 en Buenos Aires → "ayer" allá
    const nowBA = new Date('2026-07-26T18:00:00Z');
    expect(
      relativeListTime('2026-07-26T01:00:00Z', 'America/Argentina/Buenos_Aires', nowBA),
    ).toBe('ayer');
    // ...pero mismo día en UTC → hora
    expect(relativeListTime('2026-07-26T01:00:00Z', 'UTC', nowBA)).toBe('01:00');
  });
});
