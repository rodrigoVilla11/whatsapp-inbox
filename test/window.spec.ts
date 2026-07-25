import { describe, expect, it } from 'vitest';
import { expiredLastInboundAt, isWindowOpen, windowExpiresAt } from '../src/messaging/window';

const NOW = new Date('2026-07-25T12:00:00.000Z');
const conv = (lastInboundAt: Date | null): { lastInboundAt: Date | null } => ({ lastInboundAt });

describe('ventana de 24h', () => {
  it('abierta si el último entrante fue hace < 24h', () => {
    expect(isWindowOpen(conv(new Date('2026-07-25T11:00:00Z')), NOW)).toBe(true);
    expect(isWindowOpen(conv(new Date('2026-07-24T12:00:01Z')), NOW)).toBe(true);
  });

  it('cerrada al cumplirse exactamente 24h, después, o sin entrantes', () => {
    expect(isWindowOpen(conv(new Date('2026-07-24T12:00:00Z')), NOW)).toBe(false);
    expect(isWindowOpen(conv(new Date('2026-07-20T12:00:00Z')), NOW)).toBe(false);
    expect(isWindowOpen(conv(null), NOW)).toBe(false);
  });

  it('windowExpiresAt = lastInboundAt + 24h (la UI lo muestra)', () => {
    expect(windowExpiresAt(conv(new Date('2026-07-25T11:00:00Z')))?.toISOString()).toBe(
      '2026-07-26T11:00:00.000Z',
    );
    expect(windowExpiresAt(conv(null))).toBeNull();
  });

  it('expiredLastInboundAt: el rebobinado del 131047 cierra la ventana al instante', () => {
    const rewound = conv(expiredLastInboundAt(NOW));
    expect(isWindowOpen(rewound, NOW)).toBe(false);
    // y un entrante posterior real la reabre (valor rebobinado < timestamp nuevo)
    expect(expiredLastInboundAt(NOW).getTime()).toBeLessThan(NOW.getTime());
  });
});
