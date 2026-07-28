import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationQueryParams } from '../src/lib/api';
import { createDebounce, SEARCH_DEBOUNCE_MS } from '../src/lib/search';

/** Búsqueda de conversaciones (9c): debounce + armado de params. */

describe('createDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('colapsa llamadas rápidas en una sola, pasada la espera', () => {
    const fn = vi.fn();
    const d = createDebounce(fn, SEARCH_DEBOUNCE_MS);
    d.call();
    d.call();
    d.call();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(fn).not.toHaveBeenCalled(); // cada llamada reinicia la espera
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cada llamada nueva reinicia el timer', () => {
    const fn = vi.fn();
    const d = createDebounce(fn, 300);
    d.call();
    vi.advanceTimersByTime(200);
    d.call(); // reinicia
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pasa los últimos argumentos', () => {
    const fn = vi.fn();
    const d = createDebounce(fn, 300);
    d.call('primero');
    d.call('último');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledWith('último');
  });

  it('cancel() descarta lo pendiente', () => {
    const fn = vi.fn();
    const d = createDebounce(fn, 300);
    d.call();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('conversationQueryParams', () => {
  it('default: abiertas sin params extra', () => {
    expect(conversationQueryParams({ filter: 'open' }).toString()).toBe('');
  });

  it('status para all, closed y las vistas nuevas', () => {
    expect(conversationQueryParams({ filter: 'all' }).get('status')).toBe('all');
    expect(conversationQueryParams({ filter: 'closed' }).get('status')).toBe('closed');
    expect(conversationQueryParams({ filter: 'expiring' }).get('status')).toBe('expiring');
    expect(conversationQueryParams({ filter: 'unread' }).get('status')).toBe('unread');
  });

  it('q se recorta y va solo si tiene contenido', () => {
    expect(conversationQueryParams({ filter: 'open', q: '  maría  ' }).get('q')).toBe('maría');
    expect(conversationQueryParams({ filter: 'open', q: '   ' }).has('q')).toBe(false);
    expect(conversationQueryParams({ filter: 'open', q: null }).has('q')).toBe(false);
  });

  it('assignedToMe y cursor solo cuando aplican', () => {
    const params = conversationQueryParams({
      filter: 'open',
      assignedToMe: true,
      cursor: 'abc123',
    });
    expect(params.get('assignedToMe')).toBe('true');
    expect(params.get('cursor')).toBe('abc123');
    expect(conversationQueryParams({ filter: 'open', assignedToMe: false }).has('assignedToMe')).toBe(
      false,
    );
    expect(conversationQueryParams({ filter: 'open', cursor: null }).has('cursor')).toBe(false);
  });

  it('todo junto: la búsqueda convive con el resto', () => {
    const params = conversationQueryParams({ filter: 'all', assignedToMe: true, q: 'juan' });
    expect(params.get('status')).toBe('all');
    expect(params.get('assignedToMe')).toBe('true');
    expect(params.get('q')).toBe('juan');
  });
});
