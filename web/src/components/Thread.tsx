'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { initialOf } from '@/lib/format';
import { useInbox } from '@/lib/store';
import type { Message } from '@/lib/types';
import { Composer } from './Composer';
import { ContactPanel } from './ContactPanel';
import { MessageBubble } from './MessageBubble';
import { WindowBanner } from './WindowBanner';

export function Thread({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const conversation = useInbox((s) => s.conversations.find((c) => c.id === conversationId));
  const messages = useInbox((s) => s.messages[conversationId] ?? []);
  const hasOlder = useInbox((s) => !!s.messagesCursor[conversationId]);
  const loadOlder = useInbox((s) => s.loadOlderMessages);
  const [showContact, setShowContact] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  // Autoscroll al fondo cuando entran mensajes nuevos
  useEffect(() => {
    if (messages.length > lastCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    lastCount.current = messages.length;
  }, [messages.length]);

  // Reacciones: se cuelgan de la burbuja del mensaje reaccionado, no son burbuja
  const { visible, reactionsByWamid, byWamid } = useMemo(() => {
    const reactions = new Map<string, string[]>();
    const index = new Map<string, Message>();
    for (const m of messages) {
      if (m.wamid) index.set(m.wamid, m);
      if (m.type === 'REACTION' && m.replyToWamid && m.body) {
        reactions.set(m.replyToWamid, [...(reactions.get(m.replyToWamid) ?? []), m.body]);
      }
    }
    return {
      visible: messages.filter((m) => m.type !== 'REACTION'),
      reactionsByWamid: reactions,
      byWamid: index,
    };
  }, [messages]);

  if (!conversation) {
    return <div className="flex h-full items-center justify-center text-stone-400">Cargando…</div>;
  }
  const name =
    conversation.contact?.profileName ??
    conversation.contact?.phoneE164 ??
    conversation.contact?.waId ??
    '—';

  return (
    <div className="flex h-full flex-col bg-stone-100">
      {/* Header con panel de contacto expandible (tablet/mobile) */}
      <header className="border-b border-stone-200 bg-white">
        <div className="flex items-center gap-2 px-2 py-2">
          <button
            onClick={onBack}
            aria-label="Volver a la lista"
            className="flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 md:hidden"
          >
            ←
          </button>
          <button
            onClick={() => setShowContact((v) => !v)}
            aria-expanded={showContact}
            aria-label="Ver datos del contacto"
            className="flex min-h-12 flex-1 items-center gap-3 rounded-lg px-2 text-left hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 xl:pointer-events-none"
          >
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 font-semibold text-white"
            >
              {initialOf(conversation.contact?.profileName ?? null, name)}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-semibold">{name}</span>
              <span className="block text-xs text-stone-500">
                {conversation.contact?.phoneE164 ?? conversation.contact?.waId}
              </span>
            </span>
          </button>
        </div>
        {showContact && (
          <div className="border-t border-stone-100 xl:hidden">
            <ContactPanel conversationId={conversationId} compact />
          </div>
        )}
      </header>

      <WindowBanner conversation={conversation} />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {hasOlder && (
          <div className="mb-3 text-center">
            <button
              onClick={() => void loadOlder(conversationId)}
              className="min-h-10 rounded-full bg-white px-4 text-xs font-medium text-stone-600 shadow-sm hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            >
              Ver mensajes anteriores
            </button>
          </div>
        )}
        <ol className="space-y-2" aria-label="Mensajes">
          {visible.map((m) => (
            <li key={m.id}>
              <MessageBubble
                message={m}
                quoted={m.replyToWamid ? (byWamid.get(m.replyToWamid) ?? null) : null}
                reactions={m.wamid ? reactionsByWamid.get(m.wamid) : undefined}
              />
            </li>
          ))}
        </ol>
        <div ref={bottomRef} />
      </div>

      <Composer conversation={conversation} />
    </div>
  );
}
