import { describe, expect, it } from 'vitest';
import { conversationQueryParams } from '../src/lib/api';
import { sortConversations, upsertConversation } from '../src/lib/merge';
import { tagChipClass, tagSwatchClass, TAG_COLORS } from '../src/lib/tag-colors';
import type { Conversation, Tag } from '../src/lib/types';

/** Anclado y etiquetas: orden de la lista, merge de eventos y query params. */

const conv = (over: Partial<Conversation>): Conversation => ({
  id: 'c1',
  contactId: 'ct1',
  whatsappAccountId: 'a1',
  status: 'OPEN',
  assignedUserId: null,
  unreadCount: 0,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastMessageAt: '2026-07-25T12:00:00.000Z',
  lastMessagePreview: null,
  pinnedAt: null,
  createdAt: '2026-07-25T10:00:00.000Z',
  isWindowOpen: true,
  windowExpiresAt: null,
  contact: {
    id: 'ct1',
    waId: '549',
    phoneE164: null,
    profileName: 'Juan',
    notes: null,
    isBlocked: false,
  },
  ...over,
});

const tag = (over: Partial<Tag> = {}): Tag => ({
  id: 't1',
  name: 'Mayorista',
  slug: 'mayorista',
  color: 'nori',
  ...over,
});

describe('sortConversations con anclados', () => {
  it('el anclado va primero aunque su último mensaje sea más viejo', () => {
    const result = sortConversations([
      conv({ id: 'nueva', lastMessageAt: '2026-07-25T18:00:00.000Z' }),
      conv({
        id: 'anclada',
        lastMessageAt: '2026-07-20T08:00:00.000Z',
        pinnedAt: '2026-07-25T09:00:00.000Z',
      }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['anclada', 'nueva']);
  });

  it('entre anclados, el último anclado primero', () => {
    const result = sortConversations([
      conv({ id: 'a', pinnedAt: '2026-07-25T09:00:00.000Z' }),
      conv({ id: 'b', pinnedAt: '2026-07-25T11:00:00.000Z' }),
      conv({ id: 'c', pinnedAt: '2026-07-25T10:00:00.000Z' }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('sin anclados, el orden por fecha no cambia', () => {
    const result = sortConversations([
      conv({ id: 'vieja', lastMessageAt: '2026-07-20T08:00:00.000Z' }),
      conv({ id: 'nueva', lastMessageAt: '2026-07-25T18:00:00.000Z' }),
      conv({ id: 'sinMensajes', lastMessageAt: null }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['nueva', 'vieja', 'sinMensajes']);
  });

  it('una anclada SIN mensajes gana igual (el anclado manda sobre la fecha)', () => {
    const result = sortConversations([
      conv({ id: 'conMensajes', lastMessageAt: '2026-07-25T18:00:00.000Z' }),
      conv({ id: 'anclada', lastMessageAt: null, pinnedAt: '2026-07-25T09:00:00.000Z' }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['anclada', 'conMensajes']);
  });
});

describe('upsertConversation con anclado y etiquetas', () => {
  it('un evento que ancla mueve la fila a la punta', () => {
    const list = [
      conv({ id: 'a', lastMessageAt: '2026-07-25T18:00:00.000Z' }),
      conv({ id: 'b', lastMessageAt: '2026-07-25T12:00:00.000Z' }),
    ];
    const result = upsertConversation(
      list,
      conv({ id: 'b', lastMessageAt: '2026-07-25T12:00:00.000Z', pinnedAt: '2026-07-25T19:00:00.000Z' }),
    );
    expect(result.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('un evento SIN tags preserva las etiquetas que ya había', () => {
    const list = [conv({ id: 'a', tags: [tag()] })];
    // así viaja un conversation.updated de assign/mark-read: sin tags
    const incoming = { ...conv({ id: 'a' }) };
    delete incoming.tags;

    const result = upsertConversation(list, incoming);
    expect(result[0].tags).toEqual([tag()]);
  });

  it('un evento CON tags las reemplaza (incluso vaciándolas)', () => {
    const list = [conv({ id: 'a', tags: [tag()] })];
    const result = upsertConversation(list, conv({ id: 'a', tags: [] }));
    expect(result[0].tags).toEqual([]);
  });

  it('preservar tags no rompe la preservación de contact ni de hasActiveOrder', () => {
    const list = [conv({ id: 'a', tags: [tag()], hasActiveOrder: true })];
    const incoming = { ...conv({ id: 'a' }), contact: null };
    delete incoming.tags;
    delete incoming.hasActiveOrder;

    const result = upsertConversation(list, incoming);
    expect(result[0].tags).toEqual([tag()]);
    expect(result[0].hasActiveOrder).toBe(true);
    expect(result[0].contact?.profileName).toBe('Juan');
  });
});

describe('query params del listado', () => {
  it('manda tagIds como CSV solo si hay alguna', () => {
    expect(conversationQueryParams({ filter: 'open' }).toString()).toBe('');
    expect(conversationQueryParams({ filter: 'open', tagIds: [] }).toString()).toBe('');
    expect(conversationQueryParams({ filter: 'open', tagIds: ['t1', 't2'] }).get('tagIds')).toBe(
      't1,t2',
    );
  });

  it('el filtro por etiqueta se combina con tab, búsqueda y cursor', () => {
    const params = conversationQueryParams({
      filter: 'all',
      q: 'maria',
      cursor: 'CUR',
      tagIds: ['t1'],
    });
    expect(Object.fromEntries(params)).toEqual({
      status: 'all',
      q: 'maria',
      cursor: 'CUR',
      tagIds: 't1',
    });
  });
});

describe('colores de etiqueta', () => {
  it('cada color tiene clases de chip y de muestra', () => {
    for (const color of TAG_COLORS) {
      expect(tagChipClass(color)).toContain(`tag-${color}-soft`);
      expect(tagSwatchClass(color)).toBeTruthy();
    }
  });

  it('un color desconocido cae a piedra en vez de romper', () => {
    expect(tagChipClass('fucsia-inventado')).toBe(tagChipClass('piedra'));
    expect(tagSwatchClass('')).toBe(tagSwatchClass('piedra'));
  });

  it('gari NO es un color de etiqueta (está reservado a urgencia)', () => {
    expect(TAG_COLORS as readonly string[]).not.toContain('gari');
    // y si alguien lo fuerza, cae al default en lugar de teñirse de urgencia
    expect(tagChipClass('gari')).toBe(tagChipClass('piedra'));
  });
});
