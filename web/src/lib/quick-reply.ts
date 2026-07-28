/**
 * Variables de respuestas rápidas — lógica PURA:
 * - {{nombre}} se resuelve sola con el nombre del contacto (si no hay,
 *   se quita limpiando espacios/puntuación colgada).
 * - Cualquier otra {{variable}} (ej. {{demora}}) queda en el texto y se
 *   devuelve la posición de la PRIMERA para auto-seleccionarla en el
 *   textarea: la cajera tipea el valor directamente encima.
 */

export interface ResolvedQuickReply {
  text: string;
  /** Rango de la primera variable pendiente (para setSelectionRange). */
  firstVar: { start: number; end: number } | null;
}

const NAME_VAR = /\{\{\s*nombre\s*\}\}/gi;
const ANY_VAR = /\{\{[^{}]*\}\}/;

export function resolveQuickReply(body: string, contactName: string | null): ResolvedQuickReply {
  const name = contactName?.trim() ?? '';
  let text = body.replace(NAME_VAR, name);
  if (!name) {
    // "¡Hola {{nombre}}!" sin nombre → "¡Hola!" (ni doble espacio ni " !")
    text = text.replace(/ {2,}/g, ' ').replace(/ ([,;:!?.])/g, '$1').trim();
  }

  const match = ANY_VAR.exec(text);
  const firstVar = match
    ? { start: match.index, end: match.index + match[0].length }
    : null;
  return { text, firstVar };
}
