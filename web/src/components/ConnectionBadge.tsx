'use client';

import { useEffect, useState } from 'react';
import { useInbox } from '@/lib/store';
import { useMounted } from '@/lib/use-now';

const LONG_OUTAGE_MS = 10_000;

/**
 * Socket caído: primero un indicador discreto; si la desconexión pasa los
 * 10s, un banner claro (gari). Desaparece solo al volver la conexión.
 *
 * Hydration: el estado del socket es SOLO-CLIENTE (en SSR no hay socket y
 * el store arranca en 'reconnecting'). El primer paint debe ser idéntico
 * al del server → estado NEUTRO (nada) hasta el mount; el estado real
 * entra después. Sin suppressHydrationWarning: no hay nada que suprimir.
 */
export function ConnectionBadge() {
  const mounted = useMounted();
  const connection = useInbox((s) => s.connection);
  const [longOutage, setLongOutage] = useState(false);

  useEffect(() => {
    if (!mounted || connection === 'online') {
      setLongOutage(false);
      return;
    }
    const timer = setTimeout(() => setLongOutage(true), LONG_OUTAGE_MS);
    return () => clearTimeout(timer);
  }, [mounted, connection]);

  if (!mounted || connection === 'online') return null;

  if (longOutage) {
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 bg-gari-soft px-4 py-2 text-sm font-medium text-gari-ink"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-gari" aria-hidden />
        Sin conexión en tiempo real — reconectando…
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-ceramic py-1 text-xs font-medium text-sumi/70"
    >
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-piedra" aria-hidden />
      Reconectando…
    </div>
  );
}
