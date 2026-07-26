'use client';

import type { Conversation } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { formatCountdown, windowFraction, windowView } from '@/lib/window-ui';

/**
 * EL elemento firma (9a): la ventana de 24h como una barra que se consume,
 * siempre visible bajo el header del hilo. A dos metros: nori = respondé
 * tranquila, gari = se acaba el tiempo, piedra = venció (solo plantillas).
 * El MODO lo dicta el server (window-ui.ts); el drenado es cosmético.
 * El CTA de plantillas NO vive acá: es la acción primaria del composer.
 */
export function WindowBar({ conversation }: { conversation: Conversation }) {
  // Hydration: el drenado y el countdown dependen del reloj → placeholder
  // estable (misma altura, riel sin números) en SSR/primer paint.
  const nowDate = useNow(30_000);
  if (nowDate === null) {
    return (
      <div aria-hidden className="flex h-8 items-center gap-3 border-b border-line bg-rice px-4">
        <div
          className={`h-1.5 flex-1 rounded-full ${conversation.isWindowOpen ? 'bg-nori-soft' : 'bg-piedra-soft'}`}
        />
      </div>
    );
  }

  const view = windowView(conversation, nowDate.getTime());

  if (view.mode === 'closed') {
    return (
      <div
        role="status"
        className="flex h-8 items-center justify-center gap-3 border-b border-line bg-piedra-soft px-4"
      >
        <span aria-hidden className="h-1 max-w-16 flex-1 rounded-full bg-piedra/40" />
        <p className="whitespace-nowrap text-[13px] font-medium text-sumi/75">
          La ventana de 24h venció — solo plantillas
        </p>
        <span aria-hidden className="h-1 max-w-16 flex-1 rounded-full bg-piedra/40" />
      </div>
    );
  }

  const expiring = view.mode === 'expiring';
  const fraction = view.msLeft === null ? 1 : windowFraction(view.msLeft);
  const label =
    view.msLeft === null
      ? 'abierta'
      : expiring
        ? `vence en ${formatCountdown(view.msLeft)}`
        : formatCountdown(view.msLeft);

  return (
    <div
      role="status"
      aria-label={`Ventana de 24h: ${label}`}
      className="flex h-8 items-center gap-3 border-b border-line bg-rice px-4"
    >
      <div
        aria-hidden
        className={`h-1.5 flex-1 overflow-hidden rounded-full ${
          expiring ? 'bg-gari-soft' : 'bg-nori-soft'
        }`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            expiring ? 'bg-gari' : 'bg-nori'
          }`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <span
        className={`tnum shrink-0 font-mono text-xs font-medium ${
          expiring ? 'text-gari-ink' : 'text-nori'
        }`}
      >
        {label}
      </span>
    </div>
  );
}
