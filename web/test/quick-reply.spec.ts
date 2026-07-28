/** Variables de respuestas rápidas (chips): resolución pura. */
import { describe, expect, it } from 'vitest';
import { resolveQuickReply } from '../src/lib/quick-reply';

describe('resolveQuickReply', () => {
  it('{{nombre}} se resuelve con el nombre del contacto', () => {
    const r = resolveQuickReply('¡Hola {{nombre}}! Tu pedido está listo 🍣', 'María');
    expect(r.text).toBe('¡Hola María! Tu pedido está listo 🍣');
    expect(r.firstVar).toBeNull();
  });

  it('sin nombre: se quita limpio (ni doble espacio ni puntuación colgada)', () => {
    const r = resolveQuickReply('¡Hola {{nombre}}! ¿Cómo estás?', null);
    expect(r.text).toBe('¡Hola! ¿Cómo estás?');
  });

  it('las demás variables quedan y la PRIMERA viene con su rango para seleccionar', () => {
    const r = resolveQuickReply('{{nombre}}, tu pedido sale en {{demora}} minutos', 'Juan');
    expect(r.text).toBe('Juan, tu pedido sale en {{demora}} minutos');
    expect(r.firstVar).not.toBeNull();
    expect(r.text.slice(r.firstVar!.start, r.firstVar!.end)).toBe('{{demora}}');
  });

  it('varias variables: el rango es solo de la primera', () => {
    const r = resolveQuickReply('Sale en {{demora}} min, total {{total}}', null);
    expect(r.text.slice(r.firstVar!.start, r.firstVar!.end)).toBe('{{demora}}');
  });

  it('texto sin variables pasa intacto', () => {
    const r = resolveQuickReply('Nuestra carta: https://carta.com', 'María');
    expect(r.text).toBe('Nuestra carta: https://carta.com');
    expect(r.firstVar).toBeNull();
  });

  it('{{ Nombre }} con mayúsculas/espacios también resuelve', () => {
    const r = resolveQuickReply('Hola {{ Nombre }}', 'Ana');
    expect(r.text).toBe('Hola Ana');
  });
});
