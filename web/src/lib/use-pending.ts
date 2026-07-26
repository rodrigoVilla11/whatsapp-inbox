'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Estado de botón durante una acción async: deshabilita mientras corre —
 * nunca doble-submit. `run` ignora llamadas mientras hay una en vuelo.
 */
export function usePending(): {
  pending: boolean;
  run: (fn: () => Promise<void>) => void;
} {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback((fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    void fn().finally(() => {
      inFlight.current = false;
      setPending(false);
    });
  }, []);
  return { pending, run };
}
