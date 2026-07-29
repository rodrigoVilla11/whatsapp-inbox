/**
 * Colores de etiqueta. Espejo de src/inbox/tag-colors.ts del backend (que es
 * la autoridad: valida en el POST) y de los tokens --color-tag-*-soft/ink de
 * globals.css.
 *
 * `gari` NO está: es urgencia y solo urgencia. Una etiqueta roja competiría
 * con el chip de "por vencer", que es lo único que debe gritar en la lista.
 */
export const TAG_COLORS = ['piedra', 'nori', 'shoyu', 'wasabi', 'ume', 'ai'] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const DEFAULT_TAG_COLOR: TagColor = 'piedra';

/**
 * Clases literales por color: Tailwind necesita ver los nombres completos en
 * el fuente, así que esto NO puede construirse con template strings.
 */
const CHIP_CLASS: Record<TagColor, string> = {
  piedra: 'bg-tag-piedra-soft text-tag-piedra-ink',
  nori: 'bg-tag-nori-soft text-tag-nori-ink',
  shoyu: 'bg-tag-shoyu-soft text-tag-shoyu-ink',
  wasabi: 'bg-tag-wasabi-soft text-tag-wasabi-ink',
  ume: 'bg-tag-ume-soft text-tag-ume-ink',
  ai: 'bg-tag-ai-soft text-tag-ai-ink',
};

/** Muestra sólida para el selector de color (no es un chip de texto). */
const SWATCH_CLASS: Record<TagColor, string> = {
  piedra: 'bg-piedra',
  nori: 'bg-nori',
  shoyu: 'bg-tag-shoyu-ink',
  wasabi: 'bg-tag-wasabi-ink',
  ume: 'bg-tag-ume-ink',
  ai: 'bg-tag-ai-ink',
};

function asTagColor(color: string): TagColor {
  return (TAG_COLORS as readonly string[]).includes(color)
    ? (color as TagColor)
    : DEFAULT_TAG_COLOR;
}

/** Un color desconocido (etiqueta vieja, color retirado) cae a piedra, no rompe. */
export function tagChipClass(color: string): string {
  return CHIP_CLASS[asTagColor(color)];
}

export function tagSwatchClass(color: string): string {
  return SWATCH_CLASS[asTagColor(color)];
}
