'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatTime, initialOf, relativeListTime } from '@/lib/format';
import { type ListFilter, useInbox } from '@/lib/store';
import { toast } from '@/lib/toast';
import type { Conversation } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { formatCountdown, windowView } from '@/lib/window-ui';
import { ListSkeleton } from './Skeletons';

const FILTERS: Array<{ key: ListFilter; label: string }> = [
  { key: 'open', label: 'Abiertas' },
  { key: 'mine', label: 'Mías' },
  { key: 'all', label: 'Todas' },
  { key: 'closed', label: 'Cerradas' },
];

/**
 * Estado de ventana SIEMPRE visible en la fila — sin hover ni tooltip.
 * El rail izquierdo (4px) repite el color: se lee a dos metros.
 *
 * Hydration: con now=null (SSR y primer paint) se renderiza SOLO lo que el
 * server ya decidió (isWindowOpen), sin countdown — determinista. El
 * countdown y el modo "por vencer" entran post-mount con el reloj real.
 */
function WindowChip({ conversation, now }: { conversation: Conversation; now: number | null }) {
  if (now === null) {
    return conversation.isWindowOpen ? (
      <span className="rounded-full bg-nori-soft px-2 py-0.5 font-mono text-[11px] font-medium text-nori">
        abierta
      </span>
    ) : (
      <span className="rounded-full bg-piedra-soft px-2 py-0.5 text-[11px] font-medium text-sumi/60">
        venció
      </span>
    );
  }
  const view = windowView(conversation, now);
  if (view.mode === 'closed') {
    return (
      <span className="rounded-full bg-piedra-soft px-2 py-0.5 text-[11px] font-medium text-sumi/60">
        venció
      </span>
    );
  }
  if (view.mode === 'expiring') {
    return (
      <span className="tnum rounded-full bg-gari-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-gari-ink">
        vence {formatCountdown(view.msLeft ?? 0)}
      </span>
    );
  }
  return (
    <span className="tnum rounded-full bg-nori-soft px-2 py-0.5 font-mono text-[11px] font-medium text-nori">
      {view.msLeft === null ? 'abierta' : formatCountdown(view.msLeft)}
    </span>
  );
}

function railColor(conversation: Conversation, now: number | null): string {
  if (now === null) return conversation.isWindowOpen ? 'border-l-nori' : 'border-l-piedra/50';
  switch (windowView(conversation, now).mode) {
    case 'closed':
      return 'border-l-piedra/50';
    case 'expiring':
      return 'border-l-gari';
    default:
      return 'border-l-nori';
  }
}

export function ConversationList({
  selectedId,
  cursorId,
  onSelect,
}: {
  selectedId: string | null;
  /** Fila marcada por teclado (↑/↓ del dueño en desktop). */
  cursorId?: string | null;
  onSelect: (id: string) => void;
}) {
  const conversations = useInbox((s) => s.conversations);
  const filter = useInbox((s) => s.filter);
  const setFilter = useInbox((s) => s.setFilter);
  const searchQuery = useInbox((s) => s.searchQuery);
  const setSearchQuery = useInbox((s) => s.setSearchQuery);
  const loading = useInbox((s) => s.conversationsLoading);
  const timezone = useInbox((s) => s.timezone);
  const me = useInbox((s) => s.me);
  const users = useInbox((s) => s.users);
  const nextCursor = useInbox((s) => s.nextCursor);
  const loadMore = useInbox((s) => s.loadMoreConversations);
  const setStatus = useInbox((s) => s.setConversationStatus);

  // Reloj de la lista, seguro para hydration: null en SSR/primer paint
  // (se renderiza hora absoluta), reloj real + refresh 30s post-mount.
  const nowDate = useNow(30_000);
  const now = nowDate ? nowDate.getTime() : null;

  const [loadingMore, setLoadingMore] = useState(false);
  // filas en transición de cierre (animación antes de salir de la lista)
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(new Set());

  // scroll de la fila marcada por teclado a la vista
  useEffect(() => {
    if (!cursorId || typeof document === 'undefined') return;
    const row = document.getElementById(`conv-row-${cursorId}`);
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [cursorId]);

  function quickClose(c: Conversation): void {
    setClosingIds((prev) => new Set(prev).add(c.id));
    setTimeout(() => {
      void useInbox
        .getState()
        .setConversationStatus(c.id, 'CLOSED')
        .then(() => toast('Conversación cerrada'))
        .finally(() =>
          setClosingIds((prev) => {
            const next = new Set(prev);
            next.delete(c.id);
            return next;
          }),
        );
    }, 200);
  }

  const searching = searchQuery.trim().length > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line p-3">
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <Link
            href="/settings"
            className="min-h-10 rounded-xl px-3 py-2 text-sm text-sumi/70 hover:bg-ceramic"
          >
            Ajustes
          </Link>
        </div>

        <label className="sr-only" htmlFor="conversation-search">
          Buscar conversaciones
        </label>
        <input
          id="conversation-search"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar por nombre o teléfono"
          className="mb-2 min-h-11 w-full rounded-xl border border-line bg-rice px-3 text-sm placeholder:text-piedra"
        />

        {searching ? (
          <p className="px-1 text-xs text-piedra">
            Buscando en todas las conversaciones, cerradas incluidas.
          </p>
        ) : (
          <div role="tablist" aria-label="Filtro de conversaciones" className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => void setFilter(f.key)}
                className={`min-h-11 flex-1 rounded-xl px-1 text-[13px] font-medium ${
                  filter === f.key
                    ? 'bg-nori text-rice'
                    : 'bg-ceramic text-sumi/75 hover:bg-nori-soft'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversaciones">
        {loading && conversations.length === 0 && (
          <li>
            <ListSkeleton />
          </li>
        )}

        {conversations.map((c) => {
          const name = c.contact?.profileName ?? c.contact?.phoneE164 ?? c.contact?.waId ?? '—';
          const mine = !!me?.userId && c.assignedUserId === me.userId;
          const assignedName = c.assignedUserId
            ? mine
              ? 'Vos'
              : (users.find((u) => u.id === c.assignedUserId)?.name ?? 'Asignada')
            : null;
          const closing = closingIds.has(c.id);
          return (
            <li
              key={c.id}
              id={`conv-row-${c.id}`}
              className={`relative transition-all duration-200 ${
                closing ? 'translate-x-3 opacity-0' : ''
              }`}
            >
              <button
                onClick={() => onSelect(c.id)}
                aria-current={selectedId === c.id ? 'true' : undefined}
                className={`flex min-h-16 w-full items-center gap-3 border-b border-l-4 border-line/60 py-2 pl-2 pr-14 text-left hover:bg-ceramic ${railColor(c, now)} ${
                  selectedId === c.id ? 'bg-nori-soft' : 'bg-rice'
                } ${cursorId === c.id ? 'outline-2 -outline-offset-2 outline-nori' : ''}`}
              >
                <span
                  aria-hidden
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-nori text-lg font-semibold text-rice"
                >
                  {initialOf(c.contact?.profileName ?? null, name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold">{name}</span>
                    {c.lastMessageAt && (
                      <span className="tnum shrink-0 font-mono text-xs text-piedra">
                        {nowDate
                          ? relativeListTime(c.lastMessageAt, timezone, nowDate)
                          : formatTime(c.lastMessageAt, timezone)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-sumi/70">
                      {c.lastMessagePreview ?? ''}
                    </span>
                    {c.unreadCount > 0 && (
                      <span
                        aria-label={`${c.unreadCount} sin leer`}
                        className="tnum flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-nori px-1.5 font-mono text-xs font-semibold text-rice"
                      >
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <WindowChip conversation={c} now={now} />
                    {assignedName && (
                      <span className="max-w-24 truncate rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-sumi/70">
                        {assignedName}
                      </span>
                    )}
                    {c.status === 'CLOSED' && (
                      <span className="rounded-full bg-piedra-soft px-2 py-0.5 text-[11px] text-sumi/60">
                        Cerrada
                      </span>
                    )}
                  </span>
                </span>
              </button>

              {/* Acción rápida táctil: cerrar/reabrir sin abrir el hilo */}
              {c.status === 'CLOSED' ? (
                <button
                  onClick={() =>
                    void useInbox
                      .getState()
                      .setConversationStatus(c.id, 'OPEN')
                      .then(() => toast('Conversación reabierta'))
                  }
                  aria-label={`Reabrir conversación con ${name}`}
                  title="Reabrir"
                  className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-base text-piedra hover:bg-ceramic hover:text-sumi"
                >
                  ↺
                </button>
              ) : (
                <button
                  onClick={() => quickClose(c)}
                  disabled={closing}
                  aria-label={`Cerrar conversación con ${name}`}
                  title="Cerrar conversación"
                  className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-base text-piedra hover:bg-ceramic hover:text-sumi disabled:opacity-40"
                >
                  ✓
                </button>
              )}
            </li>
          );
        })}

        {!loading && conversations.length === 0 && (
          <li className="px-6 py-10 text-center">
            {searching ? (
              <>
                <p className="text-sm font-medium text-sumi/80">
                  No encontramos a nadie con “{searchQuery.trim()}”
                </p>
                <p className="mt-1 text-sm text-piedra">Probá con otro nombre o el teléfono.</p>
              </>
            ) : filter === 'closed' ? (
              <p className="text-sm text-piedra">Todavía no cerraste ninguna conversación.</p>
            ) : filter === 'mine' ? (
              <p className="text-sm text-piedra">
                No tenés conversaciones asignadas — tocá “Asignármela” en un hilo para tomarla.
              </p>
            ) : (
              <>
                <p className="text-sm font-medium text-sumi/80">Bandeja al día ✨</p>
                <p className="mt-1 text-sm text-piedra">
                  Cuando un cliente escriba, la conversación aparece acá.
                </p>
              </>
            )}
          </li>
        )}

        {nextCursor && (
          <li className="p-3">
            <button
              onClick={() => {
                if (loadingMore) return;
                setLoadingMore(true);
                void loadMore().finally(() => setLoadingMore(false));
              }}
              disabled={loadingMore}
              className="min-h-11 w-full rounded-xl bg-ceramic text-sm font-medium text-sumi/75 hover:bg-nori-soft disabled:opacity-50"
            >
              {loadingMore ? 'Cargando…' : 'Cargar más'}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
