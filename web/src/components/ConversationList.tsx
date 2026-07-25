'use client';

import { initialOf, listTimestamp } from '@/lib/format';
import { type ListFilter, useInbox } from '@/lib/store';
import type { Conversation } from '@/lib/types';
import { formatCountdown, windowView } from '@/lib/window-ui';

const FILTERS: Array<{ key: ListFilter; label: string }> = [
  { key: 'open', label: 'Abiertas' },
  { key: 'all', label: 'Todas' },
  { key: 'mine', label: 'Mías' },
];

/** Estado de ventana SIEMPRE visible en la fila — sin hover ni tooltip. */
function WindowChip({ conversation }: { conversation: Conversation }) {
  const view = windowView(conversation);
  if (view.mode === 'closed') {
    return (
      <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-600">
        Ventana cerrada
      </span>
    );
  }
  if (view.mode === 'expiring') {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
        Vence en {formatCountdown(view.msLeft ?? 0)}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
      Ventana abierta
    </span>
  );
}

export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const conversations = useInbox((s) => s.conversations);
  const filter = useInbox((s) => s.filter);
  const setFilter = useInbox((s) => s.setFilter);
  const timezone = useInbox((s) => s.timezone);
  const me = useInbox((s) => s.me);
  const nextCursor = useInbox((s) => s.nextCursor);
  const loadMore = useInbox((s) => s.loadMoreConversations);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-stone-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-lg font-bold">Inbox</h1>
          <a
            href="/settings/quick-replies"
            className="min-h-10 rounded-lg px-3 py-2 text-sm text-stone-600 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Ajustes
          </a>
        </div>
        <div role="tablist" aria-label="Filtro de conversaciones" className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => void setFilter(f.key)}
              className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                filter === f.key
                  ? 'bg-emerald-600 text-white'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversaciones">
        {conversations.map((c) => {
          const name = c.contact?.profileName ?? c.contact?.phoneE164 ?? c.contact?.waId ?? '—';
          const mine = !!me?.userId && c.assignedUserId === me.userId;
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                aria-current={selectedId === c.id ? 'true' : undefined}
                className={`flex min-h-16 w-full items-center gap-3 border-b border-stone-100 px-3 py-2 text-left hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-600 ${
                  selectedId === c.id ? 'bg-emerald-50' : ''
                }`}
              >
                <span
                  aria-hidden
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-lg font-semibold text-white"
                >
                  {initialOf(c.contact?.profileName ?? null, name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold">{name}</span>
                    {c.lastMessageAt && (
                      <span className="shrink-0 text-xs text-stone-500">
                        {listTimestamp(c.lastMessageAt, timezone)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-stone-600">
                      {c.lastMessagePreview ?? ''}
                    </span>
                    {c.unreadCount > 0 && (
                      <span
                        aria-label={`${c.unreadCount} sin leer`}
                        className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-xs font-bold text-white"
                      >
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <WindowChip conversation={c} />
                    {c.assignedUserId && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                        {mine ? 'Asignada a mí' : 'Asignada'}
                      </span>
                    )}
                    {c.status === 'CLOSED' && (
                      <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] text-stone-600">
                        Cerrada
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {conversations.length === 0 && (
          <li className="p-6 text-center text-sm text-stone-400">Sin conversaciones</li>
        )}
        {nextCursor && (
          <li className="p-3">
            <button
              onClick={() => void loadMore()}
              className="min-h-11 w-full rounded-lg bg-stone-100 text-sm font-medium text-stone-700 hover:bg-stone-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            >
              Cargar más
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
