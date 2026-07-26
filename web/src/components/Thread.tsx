'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { initialOf } from '@/lib/format';
import { validateFile } from '@/lib/media-constants';
import { selectMessages } from '@/lib/selectors';
import { useInbox } from '@/lib/store';
import { buildThreadItems } from '@/lib/thread-items';
import { toast } from '@/lib/toast';
import type { Message } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { usePending } from '@/lib/use-pending';
import { windowView } from '@/lib/window-ui';
import { AssignMenu } from './AssignMenu';
import { Composer } from './Composer';
import { ContactPanel } from './ContactPanel';
import { MessageBubble } from './MessageBubble';
import { ThreadSkeleton } from './Skeletons';
import { WindowBar } from './WindowBar';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function scrollToBottom(el: HTMLElement, smooth: boolean): void {
  if (smooth && !prefersReducedMotion() && typeof el.scrollTo === 'function') {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

const AT_BOTTOM_PX = 96; // margen: "estar al fondo" no es el píxel exacto
const LOAD_OLDER_PX = 160; // scroll cerca del tope → paginar hacia arriba

export function Thread({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const conversation = useInbox((s) => s.conversations.find((c) => c.id === conversationId));
  // Referencia estable vía selector compartido — jamás `?? []` inline
  // (literal nuevo por evaluación = loop infinito de getSnapshot).
  const messages = useInbox(selectMessages(conversationId));
  const loaded = useInbox((s) => s.messages[conversationId] !== undefined);
  const hasOlder = useInbox((s) => !!s.messagesCursor[conversationId]);
  const loadOlder = useInbox((s) => s.loadOlderMessages);
  const sendMedia = useInbox((s) => s.sendMedia);
  const setStatus = useInbox((s) => s.setConversationStatus);
  const timezone = useInbox((s) => s.timezone);
  const [showContact, setShowContact] = useState(false);
  const statusAction = usePending();

  // ── Scroll: auto solo si ya estabas al fondo; prepend sin saltos ──────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const prependRef = useRef<{ height: number; top: number; firstId: string | null } | null>(null);
  const loadingOlderRef = useRef(false);
  const lastCountRef = useRef(0);
  const lastConvRef = useRef<string | null>(null);

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

  // now null en SSR/primer paint → separadores con fecha absoluta (sin
  // "Hoy"/"Ayer", que dependen del reloj); refresh por minuto post-mount.
  const now = useNow(60_000);
  const items = useMemo(() => buildThreadItems(visible, timezone, now), [visible, timezone, now]);

  const maybeLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingOlderRef.current || !hasOlder) return;
    loadingOlderRef.current = true;
    prependRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      firstId: messages[0]?.id ?? null,
    };
    void loadOlder(conversationId).finally(() => {
      loadingOlderRef.current = false;
    });
  }, [conversationId, hasOlder, loadOlder, messages]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const at = dist < AT_BOTTOM_PX;
    atBottomRef.current = at;
    setAtBottom(at);
    if (at) setNewBelow(false);
    if (el.scrollTop < LOAD_OLDER_PX) maybeLoadOlder();
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Prepend de paginación: restaurar la posición exacta (sin saltos).
    if (prependRef.current) {
      const { height, top, firstId } = prependRef.current;
      if (messages[0]?.id !== firstId) {
        el.scrollTop = el.scrollHeight - height + top;
        prependRef.current = null;
        lastCountRef.current = messages.length;
        return;
      }
      // la página no trajo nada nuevo arriba: descartar el ancla
      prependRef.current = null;
    }

    // Primer render de una conversación cargada: directo al fondo.
    if (lastConvRef.current !== conversationId) {
      if (!loaded) return;
      lastConvRef.current = conversationId;
      el.scrollTop = el.scrollHeight;
      lastCountRef.current = messages.length;
      atBottomRef.current = true;
      setAtBottom(true);
      setNewBelow(false);
      return;
    }

    if (messages.length > lastCountRef.current) {
      if (atBottomRef.current) {
        scrollToBottom(el, true);
      } else if (messages[messages.length - 1]?.direction === 'INBOUND') {
        setNewBelow(true); // llegó algo mientras estabas arriba
      }
    }
    lastCountRef.current = messages.length;
  }, [messages, conversationId, loaded]);

  // ── Drag & drop de archivos al hilo ───────────────────────────────────
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  function dropFile(file: File | null): void {
    if (!file || !conversation) return;
    if (windowView(conversation).mode === 'closed') {
      toast('La ventana de 24h venció — solo plantillas');
      return;
    }
    const error = validateFile(file);
    if (error) {
      toast(error);
      return;
    }
    void sendMedia(conversationId, file, null);
  }

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-piedra">Cargando…</div>
    );
  }
  const name =
    conversation.contact?.profileName ??
    conversation.contact?.phoneE164 ??
    conversation.contact?.waId ??
    '—';
  const closed = conversation.status === 'CLOSED';

  return (
    <div
      className="relative flex h-full flex-col bg-ceramic"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        dropFile(e.dataTransfer.files?.[0] ?? null);
      }}
    >
      {/* Header con panel de contacto expandible (tablet/mobile) */}
      <header className="border-b border-line bg-rice">
        <div className="flex items-center gap-1 px-2 py-2">
          <button
            onClick={onBack}
            aria-label="Volver a la lista"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl hover:bg-ceramic md:hidden"
          >
            ←
          </button>
          <button
            onClick={() => setShowContact((v) => !v)}
            aria-expanded={showContact}
            aria-label="Ver datos del contacto"
            className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left hover:bg-ceramic xl:pointer-events-none"
          >
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-nori font-semibold text-rice"
            >
              {initialOf(conversation.contact?.profileName ?? null, name)}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-semibold">{name}</span>
              <span className="tnum block truncate font-mono text-xs text-piedra">
                {conversation.contact?.phoneE164 ?? conversation.contact?.waId}
              </span>
            </span>
          </button>

          <AssignMenu conversation={conversation} />

          <button
            onClick={() =>
              statusAction.run(async () => {
                await setStatus(conversationId, closed ? 'OPEN' : 'CLOSED');
                toast(closed ? 'Conversación reabierta' : 'Conversación cerrada');
                if (!closed) onBack();
              })
            }
            disabled={statusAction.pending}
            className="min-h-11 shrink-0 rounded-xl border border-line bg-rice px-3 text-sm font-medium text-sumi/80 hover:bg-ceramic disabled:opacity-50"
          >
            {statusAction.pending ? '…' : closed ? 'Reabrir' : 'Cerrar'}
          </button>
        </div>
        {showContact && (
          <div className="border-t border-line xl:hidden">
            <ContactPanel conversationId={conversationId} compact />
          </div>
        )}
      </header>

      <WindowBar conversation={conversation} />

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-3 py-4"
        >
          {!loaded ? (
            <ThreadSkeleton />
          ) : (
            <>
              {hasOlder && (
                <p className="mb-3 text-center text-xs text-piedra">Cargando anteriores…</p>
              )}
              {items.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                  <p className="text-sm font-medium text-sumi/80">Todavía no hay mensajes</p>
                  <p className="text-sm text-piedra">Escribile a {name} acá abajo.</p>
                </div>
              )}
              <ol className="space-y-1.5" aria-label="Mensajes">
                {items.map((item) =>
                  item.kind === 'day' ? (
                    <li key={item.key} className="py-2 text-center">
                      <span className="rounded-full border border-line bg-rice px-3 py-1 text-xs font-medium text-sumi/70">
                        {item.label}
                      </span>
                    </li>
                  ) : (
                    <li key={item.message.id} className={item.first ? 'pt-1.5' : ''}>
                      <MessageBubble
                        message={item.message}
                        last={item.last}
                        quoted={
                          item.message.replyToWamid
                            ? (byWamid.get(item.message.replyToWamid) ?? null)
                            : null
                        }
                        reactions={
                          item.message.wamid
                            ? reactionsByWamid.get(item.message.wamid)
                            : undefined
                        }
                      />
                    </li>
                  ),
                )}
              </ol>
            </>
          )}
        </div>

        {/* Ir al final / mensaje nuevo mientras estás arriba */}
        {newBelow ? (
          <button
            onClick={() => {
              const el = scrollRef.current;
              if (el) scrollToBottom(el, true);
              setNewBelow(false);
            }}
            className="absolute bottom-4 left-1/2 min-h-11 -translate-x-1/2 rounded-full bg-nori px-5 text-sm font-semibold text-rice shadow-lg hover:bg-nori-deep"
          >
            Mensaje nuevo ↓
          </button>
        ) : (
          !atBottom &&
          loaded && (
            <button
              onClick={() => {
                const el = scrollRef.current;
                if (el) scrollToBottom(el, true);
              }}
              aria-label="Ir al final"
              className="absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-rice text-xl text-sumi shadow-md hover:bg-ceramic"
            >
              ↓
            </button>
          )
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-nori bg-nori-soft/90">
            <p className="text-sm font-semibold text-nori">Soltá el archivo para enviarlo</p>
          </div>
        )}
      </div>

      <Composer conversation={conversation} />
    </div>
  );
}
