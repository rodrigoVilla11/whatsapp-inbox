'use client';

import { useToasts } from '@/lib/toast';

/** Confirmaciones discretas de acciones. Tap para descartar antes de tiempo. */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className="pointer-events-auto min-h-11 rounded-full bg-sumi px-5 py-2 text-sm font-medium text-rice shadow-lg"
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
