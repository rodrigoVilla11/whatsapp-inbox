'use client';

import { useInbox } from '@/lib/store';

/** Indicador discreto de socket caído: el stream no es confiable hasta reconectar. */
export function ConnectionBadge() {
  const connection = useInbox((s) => s.connection);
  if (connection === 'online') return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-amber-100 py-1 text-xs font-medium text-amber-900"
    >
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden />
      Reconectando…
    </div>
  );
}
