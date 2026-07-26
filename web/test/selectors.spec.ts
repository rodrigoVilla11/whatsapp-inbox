import { describe, expect, it } from 'vitest';
import { EMPTY_MESSAGES, selectMessages } from '../src/lib/selectors';
import type { Message } from '../src/lib/types';

/**
 * Contrato de estabilidad referencial de los selectores: React compara el
 * resultado de getSnapshot por REFERENCIA. Estos tests usan toBe (no
 * toEqual) a propósito — dos evaluaciones sin cambio de estado deben
 * devolver el MISMO objeto, o hay loop infinito (el bug de Thread.tsx).
 */
describe('selectMessages — referencias estables', () => {
  const someMessage = { id: 'm1' } as Message;
  const state = { messages: { c_con_mensajes: [someMessage] } };

  it('conversación SIN mensajes: dos evaluaciones → la MISMA referencia', () => {
    const selector = selectMessages('c_vacia');
    expect(selector(state)).toBe(selector(state)); // toBe: identidad, no igualdad
    expect(selector(state)).toBe(EMPTY_MESSAGES);
  });

  it('la referencia vacía es estable incluso entre selectores distintos', () => {
    // Thread crea un selector nuevo por render: la estabilidad no puede
    // depender de la identidad del selector, solo del resultado.
    expect(selectMessages('a')(state)).toBe(selectMessages('b')(state));
  });

  it('conversación CON mensajes: devuelve el array del store tal cual', () => {
    const selector = selectMessages('c_con_mensajes');
    expect(selector(state)).toBe(state.messages.c_con_mensajes);
    expect(selector(state)).toBe(selector(state));
  });

  it('la lista de conversaciones se selecciona cruda (documentación del patrón)', () => {
    // El filtrado Abiertas/Todas/Mías es SERVER-SIDE (setFilter → refetch):
    // el selector devuelve s.conversations sin transformar, así que es
    // estable por construcción. Si algún día el filtrado pasa a client-side,
    // va en useMemo sobre esta referencia, jamás dentro del selector.
    const s = { conversations: [] as unknown[] };
    const selector = (st: typeof s) => st.conversations;
    expect(selector(s)).toBe(selector(s));
  });
});
