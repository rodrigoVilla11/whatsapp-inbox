'use client';

/** Skeletons de carga (nunca spinners a pantalla completa). */

export function ListSkeleton() {
  return (
    <div aria-hidden className="animate-pulse">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line/60 px-3 py-3">
          <div className="h-11 w-11 shrink-0 rounded-full bg-piedra-soft" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/5 rounded bg-piedra-soft" />
            <div className="h-3 w-4/5 rounded bg-piedra-soft/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThreadSkeleton() {
  const widths = ['w-48', 'w-64', 'w-40', 'w-56', 'w-72', 'w-44'];
  return (
    <div aria-hidden className="animate-pulse space-y-3 px-4 py-6">
      {widths.map((w, i) => (
        <div key={i} className={`flex ${i % 3 === 2 ? 'justify-end' : 'justify-start'}`}>
          <div className={`h-12 max-w-[75%] rounded-2xl bg-piedra-soft ${w}`} />
        </div>
      ))}
    </div>
  );
}
