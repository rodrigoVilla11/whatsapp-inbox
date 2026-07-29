'use client';

/** Mapa de atajos (se abre con "?"). Desktop-first: es para el dueño. */

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: '↑ / ↓', action: 'Navegar la lista' },
  { keys: 'Enter', action: 'Abrir la conversación marcada' },
  { keys: 'Esc', action: 'Salir de la panorámica / volver a la lista' },
  { keys: 'E', action: 'Ver todos los chats (panorámica)' },
  { keys: '/', action: 'Respuestas rápidas (en el mensaje)' },
  { keys: '?', action: 'Mostrar u ocultar esta ayuda' },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Atajos de teclado"
      className="fixed inset-0 z-50 flex items-center justify-center bg-sumi/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-rice p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold">Atajos de teclado</h2>
        <dl className="space-y-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-4">
              <dt className="rounded-md border border-line bg-ceramic px-2 py-1 font-mono text-xs">
                {s.keys}
              </dt>
              <dd className="text-sm text-sumi/80">{s.action}</dd>
            </div>
          ))}
        </dl>
        <button
          onClick={onClose}
          className="mt-4 min-h-11 w-full rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep"
        >
          Listo
        </button>
      </div>
    </div>
  );
}
