import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, parsePrefs } from '../src/lib/prefs';

/** Preferencias de dispositivo (9c): default + override tolerante. */

describe('DEFAULT_PREFS', () => {
  it('sonido ON, notificaciones nativas OFF (opt-in), Enter envía', () => {
    expect(DEFAULT_PREFS).toEqual({
      sound: true,
      nativeNotifications: false,
      enterSends: true,
    });
  });
});

describe('parsePrefs', () => {
  it('sin nada guardado → defaults', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('JSON inválido o de otra forma → defaults (no rompe el arranque)', () => {
    expect(parsePrefs('{{{')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"texto"')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('[1,2]')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('null')).toEqual(DEFAULT_PREFS);
  });

  it('override parcial: lo guardado pisa, lo ausente conserva el default', () => {
    expect(parsePrefs('{"sound":false}')).toEqual({ ...DEFAULT_PREFS, sound: false });
    expect(parsePrefs('{"enterSends":false,"nativeNotifications":true}')).toEqual({
      sound: true,
      nativeNotifications: true,
      enterSends: false,
    });
  });

  it('tipos incorrectos se ignoran campo a campo', () => {
    expect(parsePrefs('{"sound":"si","enterSends":false}')).toEqual({
      ...DEFAULT_PREFS,
      enterSends: false,
    });
  });

  it('claves desconocidas no se cuelan', () => {
    const parsed = parsePrefs('{"sound":false,"hacker":true}');
    expect(parsed).toEqual({ ...DEFAULT_PREFS, sound: false });
    expect('hacker' in parsed).toBe(false);
  });
});
