/** Borradores por conversación: parseo tolerante y semántica del store. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFTS_STORAGE_KEY, parseDrafts, useDrafts } from '../src/lib/drafts';

describe('parseDrafts', () => {
  it('null/basura/formas raras → {}', () => {
    expect(parseDrafts(null)).toEqual({});
    expect(parseDrafts('{{{')).toEqual({});
    expect(parseDrafts('[1,2]')).toEqual({});
    expect(parseDrafts('"texto"')).toEqual({});
  });

  it('conserva solo strings con contenido', () => {
    expect(parseDrafts('{"c1":"hola","c2":"","c3":123,"c4":"  "}')).toEqual({ c1: 'hola' });
  });
});

describe('useDrafts.setDraft', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    });
    useDrafts.setState({ drafts: {}, hydrated: false });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('guarda, persiste y texto vacío borra', () => {
    useDrafts.getState().setDraft('c1', 'quiero dos rolls');
    expect(useDrafts.getState().drafts.c1).toBe('quiero dos rolls');
    expect(JSON.parse(storage.get(DRAFTS_STORAGE_KEY)!)).toEqual({ c1: 'quiero dos rolls' });

    useDrafts.getState().setDraft('c1', '   ');
    expect(useDrafts.getState().drafts.c1).toBeUndefined();
    expect(JSON.parse(storage.get(DRAFTS_STORAGE_KEY)!)).toEqual({});
  });

  it('sin cambios no re-escribe el estado (referencia estable)', () => {
    useDrafts.getState().setDraft('c1', 'hola');
    const before = useDrafts.getState().drafts;
    useDrafts.getState().setDraft('c1', 'hola'); // mismo valor
    useDrafts.getState().setDraft('c2', '');     // borrar lo inexistente
    expect(useDrafts.getState().drafts).toBe(before);
  });

  it('hydrate carga lo persistido una sola vez', () => {
    storage.set(DRAFTS_STORAGE_KEY, '{"c9":"pendiente"}');
    useDrafts.getState().hydrate();
    expect(useDrafts.getState().drafts.c9).toBe('pendiente');
  });
});
