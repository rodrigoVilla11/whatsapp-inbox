'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, isUnauthorized } from '@/lib/api';

/**
 * Deep-link desde Gourmetify — reemplazo de la redirección a WhatsApp Web.
 * Contrato = formato wa.me: /whatsapp?phone=<dígitos internacionales>&text=<msj>
 * Abre (o crea) la conversación de ese teléfono y precarga el texto en el
 * composer. Sin sesión: el 401 global redirige a /login con next de vuelta acá.
 */
export default function WhatsappDeepLink() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode: una sola resolución
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const phone = params.get('phone')?.trim() ?? '';
    const text = params.get('text')?.trim() ?? '';
    if (!phone) {
      setError('Falta el teléfono en el link (?phone=…).');
      return;
    }

    api
      .openByPhone(phone)
      .then(({ conversation }) => {
        const draft = text ? `?draft=${encodeURIComponent(text)}` : '';
        router.replace(`/c/${conversation.id}${draft}`);
      })
      .catch((err) => {
        if (isUnauthorized(err)) return; // el redirect a login ya corre
        setError(err instanceof Error ? err.message : 'No se pudo abrir la conversación.');
      });
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        {error ? (
          <div className="rounded-2xl border border-line bg-rice p-5">
            <p className="text-sm font-medium text-gari-ink">{error}</p>
            <p className="mt-2 text-sm text-piedra">
              Verificá el número o abrí el inbox y buscá al cliente por teléfono.
            </p>
            <button
              onClick={() => router.replace('/')}
              className="mt-4 min-h-11 w-full rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep"
            >
              Ir al inbox
            </button>
          </div>
        ) : (
          <div aria-busy="true">
            <div className="mx-auto h-1.5 w-32 overflow-hidden rounded-full bg-nori-soft">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-nori" />
            </div>
            <p className="mt-4 text-sm text-piedra">Abriendo la conversación…</p>
          </div>
        )}
      </div>
    </main>
  );
}
