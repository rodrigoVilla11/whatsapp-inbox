/**
 * Colores válidos de etiqueta. Espejo de los tokens `--color-tag-*-soft/ink`
 * de web/src/app/globals.css (ver también web/src/lib/tag-colors.ts).
 *
 * `gari` NO está y no debe estar: es el color de urgencia y solo de urgencia
 * ("por vencer"). Una etiqueta roja competiría visualmente con eso.
 */
export const TAG_COLORS = ['piedra', 'nori', 'shoyu', 'wasabi', 'ume', 'ai'] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const DEFAULT_TAG_COLOR: TagColor = 'piedra';

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

export const TAG_NAME_MAX = 24;

/**
 * Identidad de una etiqueta: minúsculas, sin acentos, sin repetir
 * separadores. Es lo que hace que "Mayorista", "mayorista" y "  MAYORISTA "
 * sean la MISMA etiqueta — el error clásico de las etiquetas libres.
 *
 * Devuelve '' si no queda nada utilizable (solo símbolos, por ejemplo), y
 * el caller lo trata como nombre inválido.
 */
export function tagSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas diacríticas: á → a, ñ → n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
