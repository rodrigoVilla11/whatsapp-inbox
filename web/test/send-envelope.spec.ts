import { describe, expect, it } from 'vitest';
import { parseSendEnvelope } from '../src/lib/api';
import { formatDay, formatTime, listTimestamp, relativeListTime } from '../src/lib/format';

/**
 * Regresión del crash al enviar media.
 *
 * El backend contesta { message, error } en los envíos, pero un throw de
 * Nest contesta { statusCode, message: string, error: string } — misma forma,
 * tipos distintos. Se confiaba en el cast y ese `message` STRING entraba al
 * store como si fuera un Message; el render llamaba formatTime(undefined) y
 * Intl tiraba RangeError, que sin error boundary se llevaba la página entera.
 */
describe('parseSendEnvelope', () => {
  it('cuerpo de excepción de Nest → error de dominio, message NUNCA un string', () => {
    const result = parseSendEnvelope(
      { statusCode: 500, message: 'Internal server error' },
      500,
    );
    expect(result.message).toBeNull(); // el string no pasa como Message
    expect(result.error).toEqual({ code: 'SERVER_ERROR', message: 'Internal server error' });
    expect(result.httpStatus).toBe(500);
  });

  it('400 de validación → usa el texto accionable del server', () => {
    const result = parseSendEnvelope(
      { statusCode: 400, message: "Falta el archivo (campo multipart 'file')", error: 'Bad Request' },
      400,
    );
    expect(result.message).toBeNull();
    // `error: 'Bad Request'` es un STRING: no debe pasar como error de dominio
    expect(result.error?.code).toBe('SERVER_ERROR');
    expect(result.error?.message).toMatch(/Falta el archivo/);
  });

  it('message como array (ValidationPipe) → toma el primero, no el array', () => {
    const result = parseSendEnvelope({ statusCode: 400, message: ['campo inválido', 'otro'] }, 400);
    expect(result.message).toBeNull();
    expect(result.error?.message).toBe('campo inválido');
  });

  it('envelope real 200 → pasa el Message tal cual', () => {
    const message = { id: 'm1', type: 'IMAGE', timestamp: '2026-07-26T18:00:00Z' };
    const result = parseSendEnvelope({ message, error: null }, 200);
    expect(result.message).toBe(message);
    expect(result.error).toBeNull();
  });

  it('error de dominio real (422 WINDOW_EXPIRED) → pasa sin tocar', () => {
    const error = { code: 'WINDOW_EXPIRED', message: 'La ventana está cerrada', windowExpiresAt: null };
    const result = parseSendEnvelope({ message: null, error }, 422);
    expect(result.error).toBe(error);
  });

  it('body no-JSON / vacío con status de error → error sintético mostrable', () => {
    const result = parseSendEnvelope(null, 502);
    expect(result.message).toBeNull();
    expect(result.error?.message).toMatch(/502/);
  });

  it('body no-JSON con status OK → sin error ni message (no inventa nada)', () => {
    expect(parseSendEnvelope(null, 200)).toEqual({ message: null, error: null, httpStatus: 200 });
  });
});

/**
 * Segunda línea de defensa: los formateadores corren en render y un throw
 * ahí tumba la pantalla. Una fecha inválida se muestra como hueco.
 */
describe('formateadores con fecha inválida', () => {
  const TZ = 'America/Argentina/Buenos_Aires';

  it('no tiran RangeError y devuelven string vacío', () => {
    for (const bad of [undefined as unknown as string, '', 'no-es-fecha', 'Internal server error']) {
      expect(() => formatTime(bad, TZ)).not.toThrow();
      expect(() => formatDay(bad, TZ)).not.toThrow();
      expect(() => listTimestamp(bad, TZ)).not.toThrow();
      expect(() => relativeListTime(bad, TZ)).not.toThrow();
      expect(formatTime(bad, TZ)).toBe('');
      expect(relativeListTime(bad, TZ)).toBe('');
    }
  });

  it('con fecha válida sigue formateando igual', () => {
    expect(formatTime('2026-07-26T18:00:00Z', 'UTC')).toBe('18:00');
    expect(formatDay('2026-07-26T18:00:00Z', 'UTC')).toMatch(/^26\/0?7$/);
  });
});
