'use client';

import { useEffect, useRef, useState } from 'react';
import { orderChipClasses } from '@/lib/order-ui';
import { selectOrders } from '@/lib/selectors';
import { useInbox } from '@/lib/store';
import { toast } from '@/lib/toast';
import type { GourmetifyOrder } from '@/lib/types';
import { usePending } from '@/lib/use-pending';
import { TagPicker } from './TagPicker';

/** Card de pedido (activo = completa; cerrado = compacta). */
function OrderCard({ order, compact = false }: { order: GourmetifyOrder; compact?: boolean }) {
  return (
    <div className={`rounded-xl border border-line bg-rice ${compact ? 'px-3 py-2' : 'p-3'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="tnum font-mono text-xs font-medium text-sumi/80">
          {order.number ? `Pedido #${order.number}` : 'Pedido'}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${orderChipClasses(order.statusKind)}`}
        >
          {order.statusLabel}
        </span>
      </div>
      {!compact && order.summary && (
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-sumi/85">{order.summary}</p>
      )}
      {!compact && (order.totalLabel || order.scheduledLabel || order.deliveryLabel) && (
        <p className="tnum mt-1.5 font-mono text-xs text-piedra">
          {[order.totalLabel, order.deliveryLabel, order.scheduledLabel]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

const NOTES_DEBOUNCE_MS = 800;

type SaveState = 'idle' | 'pending' | 'saved' | 'error';

/** Panel lateral (columna en desktop, header expandible en tablet/mobile). */
export function ContactPanel({
  conversationId,
  compact = false,
}: {
  conversationId: string;
  compact?: boolean;
}) {
  const conversation = useInbox((s) => s.conversations.find((c) => c.id === conversationId));
  const panelContactId = useInbox(
    (s) => s.conversations.find((c) => c.id === conversationId)?.contact?.id ?? null,
  );
  const orders = useInbox(selectOrders(panelContactId));
  const me = useInbox((s) => s.me);
  const assign = useInbox((s) => s.assign);
  const setStatus = useInbox((s) => s.setConversationStatus);
  const saveContactNotes = useInbox((s) => s.saveContactNotes);
  const togglePin = useInbox((s) => s.togglePin);
  const assignAction = usePending();
  const statusAction = usePending();
  const pinAction = usePending();

  // Notas con guardado por debounce y confirmación discreta.
  const [notes, setNotes] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contactId = conversation?.contact?.id ?? null;
  const serverNotes = conversation?.contact?.notes ?? '';

  // al cambiar de contacto, el borrador local arranca del server
  useEffect(() => {
    setNotes(serverNotes);
    setSaveState('idle');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  function onNotesChange(value: string): void {
    setNotes(value);
    setSaveState('pending');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveContactNotes(conversationId, value)
        .then(() => {
          setSaveState('saved');
          setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2500);
        })
        .catch(() => setSaveState('error'));
    }, NOTES_DEBOUNCE_MS);
  }

  if (!conversation) return null;
  const contact = conversation.contact;
  const mine = !!me?.userId && conversation.assignedUserId === me.userId;
  const phone = contact?.phoneE164 ?? contact?.waId ?? null;

  async function copyPhone(): Promise<void> {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      toast('Teléfono copiado');
    } catch {
      toast('No se pudo copiar — anotalo a mano');
    }
  }

  return (
    <div className={`space-y-4 ${compact ? 'p-3' : 'p-4'}`}>
      {!compact && (
        <div>
          <h2 className="text-lg font-semibold">{contact?.profileName ?? 'Sin nombre'}</h2>
        </div>
      )}

      {phone && (
        <button
          onClick={() => void copyPhone()}
          title="Copiar teléfono"
          className="tnum flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-line bg-rice px-3 font-mono text-sm hover:bg-ceramic"
        >
          <span className="truncate">{phone}</span>
          <span aria-hidden className="text-piedra">
            ⧉
          </span>
          <span className="sr-only">Copiar teléfono</span>
        </button>
      )}

      {/* Pedidos de Gourmetify: sin integración/pedidos, la sección no existe */}
      {(orders.active.length > 0 || orders.recent.length > 0) && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-piedra">
            Pedidos
          </h3>
          <div className="space-y-2">
            {orders.active.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
            {orders.recent.length > 0 && (
              <div className="space-y-1.5">
                {orders.active.length > 0 && (
                  <p className="text-[11px] text-piedra">Anteriores</p>
                )}
                {orders.recent.map((order) => (
                  <OrderCard key={order.id} order={order} compact />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-piedra">WhatsApp</dt>
          <dd className="tnum font-mono text-[13px] font-medium">{contact?.waId ?? '—'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-piedra">Estado</dt>
          <dd className="font-medium">
            {conversation.status === 'CLOSED' ? 'Cerrada' : 'Abierta'}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-piedra">Asignación</dt>
          <dd className="font-medium">
            {conversation.assignedUserId ? (mine ? 'Vos' : 'Otro agente') : 'Sin asignar'}
          </dd>
        </div>
      </dl>

      {/* Etiquetas: cualquier agente puede crear y aplicar desde acá */}
      <TagPicker conversationId={conversation.id} />

      <div className="space-y-2">
        {/* Anclar: compartido, lo ve todo el equipo arriba de la lista */}
        <button
          onClick={() => pinAction.run(() => togglePin(conversation.id))}
          disabled={pinAction.pending}
          aria-pressed={!!conversation.pinnedAt}
          className={`min-h-11 w-full rounded-xl border text-sm font-medium disabled:opacity-50 ${
            conversation.pinnedAt
              ? 'border-nori bg-nori-soft text-nori'
              : 'border-line text-sumi/80 hover:bg-ceramic'
          }`}
        >
          {pinAction.pending
            ? 'Guardando…'
            : conversation.pinnedAt
              ? '📌 Anclada arriba — desanclar'
              : '📌 Anclar arriba'}
        </button>

        {/* Asignación: que dos personas no contesten lo mismo */}
        {me?.userId &&
          (mine ? (
            <button
              onClick={() =>
                assignAction.run(async () => {
                  await assign(conversation.id, null);
                  toast('Conversación liberada');
                })
              }
              disabled={assignAction.pending}
              className="min-h-11 w-full rounded-xl border border-line text-sm font-medium hover:bg-ceramic disabled:opacity-50"
            >
              {assignAction.pending ? 'Guardando…' : 'Liberar conversación'}
            </button>
          ) : (
            <button
              onClick={() =>
                assignAction.run(async () => {
                  await assign(conversation.id, me.userId);
                  toast('Asignada a vos');
                })
              }
              disabled={assignAction.pending}
              className="min-h-11 w-full rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep disabled:opacity-50"
            >
              {assignAction.pending ? 'Guardando…' : 'Asignármela'}
            </button>
          ))}

        {conversation.status === 'CLOSED' ? (
          <button
            onClick={() =>
              statusAction.run(async () => {
                await setStatus(conversation.id, 'OPEN');
                toast('Conversación reabierta');
              })
            }
            disabled={statusAction.pending}
            className="min-h-11 w-full rounded-xl border border-nori text-sm font-semibold text-nori hover:bg-nori-soft disabled:opacity-50"
          >
            {statusAction.pending ? 'Guardando…' : 'Reabrir'}
          </button>
        ) : (
          <button
            onClick={() =>
              statusAction.run(async () => {
                await setStatus(conversation.id, 'CLOSED');
                toast('Conversación cerrada');
              })
            }
            disabled={statusAction.pending}
            className="min-h-11 w-full rounded-xl border border-line text-sm font-medium text-sumi/80 hover:bg-ceramic disabled:opacity-50"
          >
            {statusAction.pending ? 'Guardando…' : 'Cerrar conversación'}
          </button>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label
            htmlFor={`contact-notes-${compact ? 'compact' : 'full'}`}
            className="text-xs font-semibold uppercase tracking-wide text-piedra"
          >
            Notas
          </label>
          <span
            role="status"
            className={`text-[11px] ${saveState === 'error' ? 'font-medium text-gari-ink' : 'text-piedra'}`}
          >
            {saveState === 'pending' && 'Guardando…'}
            {saveState === 'saved' && 'Guardado ✓'}
            {saveState === 'error' && 'No se guardó — seguí escribiendo para reintentar'}
          </span>
        </div>
        <textarea
          id={`contact-notes-${compact ? 'compact' : 'full'}`}
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          rows={compact ? 2 : 4}
          maxLength={5000}
          placeholder="Ej.: pide sin wasabi, retira siempre 21:30"
          className="w-full resize-none rounded-xl border border-line bg-rice px-3 py-2 text-sm placeholder:text-piedra"
        />
      </div>
    </div>
  );
}
