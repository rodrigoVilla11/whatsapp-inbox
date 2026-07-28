'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useDrafts } from '@/lib/drafts';
import { initNotifications } from '@/lib/notify';
import { usePrefs } from '@/lib/prefs';
import { connectInboxSocket } from '@/lib/socket';
import { useInbox } from '@/lib/store';
import { ChangePasswordGate } from './ChangePasswordGate';
import { ConnectionBadge } from './ConnectionBadge';
import { ContactPanel } from './ContactPanel';
import { ConversationList } from './ConversationList';
import { ShortcutHelp } from './ShortcutHelp';
import { Thread } from './Thread';
import { Toasts } from './Toasts';

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
  const conversations = useInbox((s) => s.conversations);
  const tenantName = useInbox((s) => s.me?.tenantName ?? null);
  const meUserId = useInbox((s) => s.me?.userId ?? null);
  const mustChangePassword = useInbox((s) => s.me?.mustChangePassword ?? false);

  // Cursor de teclado sobre la lista (↑/↓ marca, Enter abre) + ayuda "?"
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    // Un 401 acá redirige a /login (manejo global en api.ts).
    void bootstrap();
  }, [bootstrap]);

  // El socket se conecta DESPUÉS del login confirmado (me resuelto): el
  // handshake necesita la cookie de sesión validada.
  useEffect(() => {
    if (!meUserId) return;
    const disconnect = connectInboxSocket();
    return disconnect;
  }, [meUserId]);

  useEffect(() => {
    void select(selectedId);
  }, [selectedId, select]);

  // Preferencias + borradores del dispositivo + notificaciones
  useEffect(() => {
    usePrefs.getState().hydrate();
    useDrafts.getState().hydrate();
    return initNotifications((id) => router.push(`/c/${id}`));
  }, [router]);

  // Badge de no-leídos en el título de la pestaña: "(3) Inbox — Nova Sushi"
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const total = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
    const base = `Inbox — ${tenantName ?? 'WhatsApp'}`;
    document.title = total > 0 ? `(${total}) ${base}` : base;
  }, [conversations, tenantName]);

  // Atajos de teclado (desktop): ↑/↓ lista, Enter abrir, Esc volver, ? ayuda
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');

      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
          return;
        }
        if (!typing && selectedId) router.push('/');
        return;
      }
      if (typing) return;

      if (e.key === '?') {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (conversations.length === 0) return;
        e.preventDefault();
        const current = conversations.findIndex((c) => c.id === (cursorId ?? selectedId));
        const next =
          e.key === 'ArrowDown'
            ? Math.min(conversations.length - 1, current + 1)
            : Math.max(0, current <= 0 ? 0 : current - 1);
        setCursorId(conversations[next].id);
        return;
      }
      if (e.key === 'Enter' && cursorId) {
        router.push(`/c/${cursorId}`);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversations, cursorId, selectedId, showHelp, router]);

  // Password provisoria: no hay inbox hasta elegir la definitiva.
  if (mustChangePassword) return <ChangePasswordGate />;

  return (
    <div className="flex h-dvh flex-col">
      <ConnectionBadge />
      {lastError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 bg-gari px-4 py-2 text-sm font-medium text-white"
        >
          <span>{lastError}</span>
          <button
            onClick={dismissError}
            className="min-h-10 rounded-lg px-3 font-semibold hover:bg-gari-ink"
            aria-label="Cerrar aviso de error"
          >
            Cerrar
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Lista: oculta en mobile cuando hay hilo abierto */}
        <aside
          className={`w-full shrink-0 border-r border-line bg-rice md:block md:w-80 lg:w-96 ${
            selectedId ? 'hidden' : 'block'
          }`}
        >
          <ConversationList
            selectedId={selectedId}
            cursorId={cursorId}
            onSelect={(id) => router.push(`/c/${id}`)}
          />
        </aside>

        {/* Hilo */}
        <main className={`min-w-0 flex-1 ${selectedId ? 'block' : 'hidden md:block'}`}>
          {selectedId ? (
            <Thread conversationId={selectedId} onBack={() => router.push('/')} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm font-medium text-sumi/70">Elegí una conversación</p>
              <p className="text-sm text-piedra">
                El color del borde te dice cómo viene la ventana de 24h.
              </p>
            </div>
          )}
        </main>

        {/* Panel de contacto: solo desktop ancho */}
        {selectedId && (
          <aside className="hidden w-72 shrink-0 border-l border-line bg-rice xl:block">
            <ContactPanel conversationId={selectedId} />
          </aside>
        )}
      </div>

      <Toasts />
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}
