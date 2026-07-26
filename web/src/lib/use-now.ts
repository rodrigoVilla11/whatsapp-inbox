'use client';

import { useEffect, useState } from 'react';

/**
 * Reloj para render dependiente de tiempo, seguro para hydration:
 * devuelve NULL en SSR y en el primer paint del cliente (idénticos por
 * definición), y la hora real recién post-mount, refrescada por intervalo.
 * Regla de la casa: con null se renderiza el valor ABSOLUTO o un
 * placeholder estable; lo relativo ("5 min", countdowns) aparece después.
 */
export function useNow(intervalMs: number): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** true recién después del mount — para estado solo-cliente (socket, etc.). */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
