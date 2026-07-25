import { describe, expect, it } from 'vitest';
import { formatCountdown, windowView } from '../src/lib/window-ui';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

describe('windowView (presentación desde los campos del SERVIDOR)', () => {
  it('server dice cerrada → closed, sin importar el reloj local', () => {
    expect(windowView({ isWindowOpen: false, windowExpiresAt: iso(3600_000) }, NOW).mode).toBe(
      'closed',
    );
    expect(windowView({ isWindowOpen: false, windowExpiresAt: null }, NOW).mode).toBe('closed');
  });

  it('abierta con más de 2h → open con msLeft cosmético', () => {
    const view = windowView({ isWindowOpen: true, windowExpiresAt: iso(5 * 3600_000) }, NOW);
    expect(view.mode).toBe('open');
    expect(view.msLeft).toBe(5 * 3600_000);
  });

  it('abierta con menos de 2h → expiring con countdown', () => {
    const view = windowView({ isWindowOpen: true, windowExpiresAt: iso(90 * 60_000) }, NOW);
    expect(view.mode).toBe('expiring');
    expect(view.msLeft).toBe(90 * 60_000);
  });

  it('reloj local pasado pero server aún dice abierta → expiring en 0 (el server manda)', () => {
    const view = windowView({ isWindowOpen: true, windowExpiresAt: iso(-60_000) }, NOW);
    expect(view.mode).toBe('expiring');
    expect(view.msLeft).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('formatea horas y minutos', () => {
    expect(formatCountdown(90 * 60_000)).toBe('1h 30m');
    expect(formatCountdown(45 * 60_000)).toBe('45m');
    expect(formatCountdown(30_000)).toBe('<1m');
  });
});
