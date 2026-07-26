'use client';

import { useEffect, useRef, useState } from 'react';
import { useInbox } from '@/lib/store';
import { toast } from '@/lib/toast';
import { usePending } from '@/lib/use-pending';

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
  const me = useInbox((s) => s.me);
  const assign = useInbox((s) => s.assign);
  const setStatus = useInbox((s) => s.setConversationStatus);
  const saveContactNotes = useInbox((s) => s.saveContactNotes);
  const assignAction = usePending();
  const statusAction = usePending();

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

      <div className="space-y-2">
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
