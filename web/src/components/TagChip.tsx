'use client';

import { tagChipClass } from '@/lib/tag-colors';
import type { Tag } from '@/lib/types';

/**
 * Chip de etiqueta. Tres usos: decorativo (fila de la lista), interactivo
 * (chip de filtro) y removible (panel de contacto).
 */
export function TagChip({
  tag,
  onRemove,
  onClick,
  active,
  className = '',
}: {
  tag: Tag;
  /** Muestra la × y llama a esto (panel de contacto). */
  onRemove?: () => void;
  /** Hace del chip un botón (filtro de la lista). */
  onClick?: () => void;
  /** Chip de filtro encendido: se marca con un anillo, no con otro color. */
  active?: boolean;
  className?: string;
}) {
  const base = `inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tagChipClass(
    tag.color,
  )} ${active ? 'ring-2 ring-sumi/40' : ''} ${className}`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={!!active}
        className={`${base} min-h-8 hover:brightness-95`}
      >
        <span className="truncate">{tag.name}</span>
      </button>
    );
  }

  return (
    <span className={base}>
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Quitar la etiqueta ${tag.name}`}
          // Área táctil real sin agrandar el chip: el hit box se extiende
          // con padding negativo del propio chip.
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px] leading-none hover:bg-sumi/10"
        >
          ✕
        </button>
      )}
    </span>
  );
}
