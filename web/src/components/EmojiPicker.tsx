'use client';

import { useEffect, useRef } from 'react';

/**
 * Picker propio, minimal y sin dependencias: una grilla curada (mostrador
 * de sushi + gestos de atención al cliente). Targets de 44px.
 */
const EMOJIS = [
  '😀', '😊', '😉', '😅', '😂', '🥰',
  '🤔', '😐', '😢', '😭', '🙏', '👍',
  '👎', '👏', '🙌', '🤝', '💪', '✌️',
  '❤️', '💚', '🔥', '🎉', '✨', '⭐',
  '✅', '❌', '⏰', '📍', '🛵', '💵',
  '🍣', '🍱', '🍙', '🥢', '🍜', '🍤',
  '🥗', '🍶', '🥤', '🍰', '☕', '🍺',
];

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    // w-max: sin ancho propio, el absoluto lo topea el wrapper del botón (48px)
    // y las 6 columnas se apilan en una. max-h: entran las 7 filas sin scroll.
    <div
      ref={ref}
      role="listbox"
      aria-label="Elegir emoji"
      className="absolute bottom-full left-0 z-30 mb-2 grid max-h-88 w-max max-w-[calc(100vw-1.5rem)] grid-cols-6 gap-0.5 overflow-y-auto rounded-2xl border border-line bg-rice p-2 shadow-lg"
    >
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          role="option"
          aria-selected={false}
          onClick={() => onPick(emoji)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-xl hover:bg-ceramic"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
