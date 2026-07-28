import { describe, expect, it } from 'vitest';
import { buildThreadItems, dayLabel, GROUP_WINDOW_MS } from '../src/lib/thread-items';
import type { Message } from '../src/lib/types';

/** Agrupación pura del hilo (9b): separadores de día + grupos por autor. */

const TZ = 'UTC';
const NOW = new Date('2026-07-26T18:00:00Z');

let seq = 0;
function msg(over: Partial<Message>): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    wamid: null,
    clientDedupKey: null,
    direction: 'INBOUND',
    type: 'TEXT',
    status: 'DELIVERED',
    body: 'hola',
    replyToWamid: null,
    templateName: null,
    templateLanguage: null,
    mediaMimeType: null,
    mediaFilename: null,
    mediaSizeBytes: null,
    mediaStatus: null,
    transcription: null,
    isAutoReply: false,
    errorCode: null,
    errorTitle: null,
    errorDetail: null,
    sentByUserId: null,
    timestamp: '2026-07-26T12:00:00Z',
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    createdAt: '2026-07-26T12:00:00Z',
    ...over,
  };
}

describe('dayLabel', () => {
  it('Hoy / Ayer / fecha corta', () => {
    expect(dayLabel('2026-07-26T09:00:00Z', TZ, NOW)).toBe('Hoy');
    expect(dayLabel('2026-07-25T23:00:00Z', TZ, NOW)).toBe('Ayer');
    // el padding del mes depende del ICU (10/07 o 10/7) — el contrato es d/m
    expect(dayLabel('2026-07-10T09:00:00Z', TZ, NOW)).toMatch(/^10\/0?7$/);
  });

  it('now=null (SSR / primer paint): SIEMPRE fecha absoluta — "Hoy" depende del reloj', () => {
    expect(dayLabel('2026-07-26T09:00:00Z', TZ, null)).toMatch(/^26\/0?7$/);
    expect(dayLabel('2026-07-25T09:00:00Z', TZ, null)).toMatch(/^25\/0?7$/);
  });
});

describe('buildThreadItems', () => {
  it('consecutivos del mismo autor dentro de la ventana → un grupo; solo la última es last', () => {
    const items = buildThreadItems(
      [
        msg({ id: 'a', timestamp: '2026-07-26T12:00:00Z' }),
        msg({ id: 'b', timestamp: '2026-07-26T12:01:00Z' }),
        msg({ id: 'c', timestamp: '2026-07-26T12:02:00Z' }),
      ],
      TZ,
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['day', 'message', 'message', 'message']);
    const flags = items
      .filter((i) => i.kind === 'message')
      .map((i) => ({ first: i.first, last: i.last }));
    expect(flags).toEqual([
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
    ]);
  });

  it('cambio de autor corta el grupo', () => {
    const items = buildThreadItems(
      [
        msg({ id: 'in', direction: 'INBOUND', timestamp: '2026-07-26T12:00:00Z' }),
        msg({ id: 'out', direction: 'OUTBOUND', timestamp: '2026-07-26T12:00:30Z' }),
      ],
      TZ,
      NOW,
    );
    const flags = items.filter((i) => i.kind === 'message');
    expect(flags.every((i) => i.first && i.last)).toBe(true); // dos grupos de uno
  });

  it('gap mayor a la ventana corta el grupo aunque sea el mismo autor', () => {
    const items = buildThreadItems(
      [
        msg({ id: 'a', timestamp: '2026-07-26T12:00:00.000Z' }),
        msg({ id: 'b', timestamp: new Date(Date.parse('2026-07-26T12:00:00Z') + GROUP_WINDOW_MS + 1000).toISOString() }),
      ],
      TZ,
      NOW,
    );
    const flags = items.filter((i) => i.kind === 'message');
    expect(flags.every((i) => i.first && i.last)).toBe(true);
  });

  it('cambio de día inserta separador y corta el grupo', () => {
    const items = buildThreadItems(
      [
        msg({ id: 'a', timestamp: '2026-07-25T23:59:00Z' }),
        msg({ id: 'b', timestamp: '2026-07-26T00:01:00Z' }), // 2 min después, otro día
      ],
      TZ,
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['day', 'message', 'day', 'message']);
    const days = items.filter((i) => i.kind === 'day');
    expect(days.map((d) => d.label)).toEqual(['Ayer', 'Hoy']);
    const flags = items.filter((i) => i.kind === 'message');
    expect(flags.every((i) => i.first && i.last)).toBe(true);
  });

  it('vacío → sin items', () => {
    expect(buildThreadItems([], TZ, NOW)).toEqual([]);
  });
});
