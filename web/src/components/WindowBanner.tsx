'use client';

import { useEffect, useState } from 'react';
import type { Conversation } from '@/lib/types';
import { formatCountdown, windowView } from '@/lib/window-ui';

/**
 * Banner del hilo según la ventana de 24h. El MODO lo decide el servidor
 * (isWindowOpen); el countdown es cosmético y se refresca por minuto.
 */
export function WindowBanner({ conversation }: { conversation: Conversation }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const view = windowView(conversation, now);
  if (view.mode === 'open') return null;

  if (view.mode === 'expiring') {
    return (
      <div
        role="status"
        className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-900"
      >
        ⏳ La ventana de 24h vence en {formatCountdown(view.msLeft ?? 0)} — después solo plantillas
      </div>
    );
  }
  return (
    <div
      role="status"
      className="border-b border-stone-300 bg-stone-200 px-4 py-2 text-center text-sm font-medium text-stone-700"
    >
      🔒 La ventana de 24h venció — enviá una plantilla para contactar al cliente
    </div>
  );
}
