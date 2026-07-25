'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { connectInboxSocket } from '@/lib/socket';
import { useInbox } from '@/lib/store';
import { ConnectionBadge } from './ConnectionBadge';
import { ContactPanel } from './ContactPanel';
import { ConversationList } from './ConversationList';
import { Thread } from './Thread';

/**
 * Layout: 3 columnas en desktop (lista / hilo / contacto); en tablet
 * vertical y mobile, lista → hilo como navegación por ruta y el panel de
 * contacto colapsa a un header expandible dentro del hilo.
 */
export function InboxShell() {
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const selectedId = params?.id ?? null;
  const bootstrap = useInbox((s) => s.bootstrap);
  const select = useInbox((s) => s.select);
  const lastError = useInbox((s) => s.lastError);
  const dismissError = useInbox((s) => s.dismissError);

  useEffect(() => {
    void bootstrap();
    const disconnect = connectInboxSocket();
    return disconnect;
  }, [bootstrap]);

  useEffect(() => {
    void select(selectedId);
  }, [selectedId, select]);

  return (
    <div className="flex h-dvh flex-col">
      <ConnectionBadge />
      {lastError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 bg-red-600 px-4 py-2 text-sm text-white"
        >
          <span>{lastError}</span>
          <button
            onClick={dismissError}
            className="min-h-10 rounded px-3 font-medium hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            aria-label="Cerrar aviso de error"
          >
            Cerrar
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Lista: oculta en mobile cuando hay hilo abierto */}
        <aside
          className={`w-full shrink-0 border-r border-stone-200 bg-white md:block md:w-80 lg:w-96 ${
            selectedId ? 'hidden' : 'block'
          }`}
        >
          <ConversationList
            selectedId={selectedId}
            onSelect={(id) => router.push(`/inbox/${id}`)}
          />
        </aside>

        {/* Hilo */}
        <main className={`min-w-0 flex-1 ${selectedId ? 'block' : 'hidden md:block'}`}>
          {selectedId ? (
            <Thread conversationId={selectedId} onBack={() => router.push('/inbox')} />
          ) : (
            <div className="flex h-full items-center justify-center text-stone-400">
              Elegí una conversación
            </div>
          )}
        </main>

        {/* Panel de contacto: solo desktop ancho */}
        {selectedId && (
          <aside className="hidden w-72 shrink-0 border-l border-stone-200 bg-white xl:block">
            <ContactPanel conversationId={selectedId} />
          </aside>
        )}
      </div>
    </div>
  );
}
