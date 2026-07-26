import type { Message } from './types';

/**
 * Selectores compartidos del store, con la garantía que React exige:
 * getSnapshot debe devolver REFERENCIAS ESTABLES entre evaluaciones sin
 * cambio de estado. Un literal ([] / {}) dentro del selector es una
 * referencia nueva cada vez → re-render → re-evaluación → loop infinito.
 *
 * Por eso el fallback vacío es una constante a nivel módulo, y los
 * selectores viven acá: puros y testeables (test/selectors.spec.ts fija
 * el contrato con toBe, no toEqual).
 */

export const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

/** Mensajes de una conversación; misma referencia siempre que no haya cambios. */
export function selectMessages(conversationId: string) {
  return (s: { messages: Record<string, Message[]> }): ReadonlyArray<Message> =>
    s.messages[conversationId] ?? EMPTY_MESSAGES;
}
