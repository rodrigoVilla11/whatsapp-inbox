'use client';

import { useInbox } from '@/lib/store';

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

  if (!conversation) return null;
  const contact = conversation.contact;
  const mine = !!me?.userId && conversation.assignedUserId === me.userId;

  return (
    <div className={`space-y-4 ${compact ? 'p-3' : 'p-4'}`}>
      {!compact && (
        <div>
          <h2 className="text-lg font-bold">{contact?.profileName ?? 'Sin nombre'}</h2>
          <p className="text-sm text-stone-600">{contact?.phoneE164 ?? contact?.waId}</p>
        </div>
      )}

      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-stone-500">WhatsApp</dt>
          <dd className="font-medium">{contact?.waId ?? '—'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-stone-500">Estado</dt>
          <dd className="font-medium">{conversation.status === 'CLOSED' ? 'Cerrada' : 'Abierta'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-stone-500">Asignación</dt>
          <dd className="font-medium">
            {conversation.assignedUserId ? (mine ? 'Yo' : 'Otro agente') : 'Sin asignar'}
          </dd>
        </div>
      </dl>

      <div className="space-y-2">
        {/* Asignación: que dos personas no contesten lo mismo */}
        {me?.userId &&
          (mine ? (
            <button
              onClick={() => void assign(conversation.id, null)}
              className="min-h-11 w-full rounded-lg border border-stone-300 text-sm font-medium hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            >
              Liberar conversación
            </button>
          ) : (
            <button
              onClick={() => void assign(conversation.id, me.userId)}
              className="min-h-11 w-full rounded-lg bg-sky-600 text-sm font-semibold text-white hover:bg-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-800"
            >
              Asignármela
            </button>
          ))}

        {conversation.status === 'CLOSED' ? (
          <button
            onClick={() => void setStatus(conversation.id, 'OPEN')}
            className="min-h-11 w-full rounded-lg border border-emerald-600 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Reabrir
          </button>
        ) : (
          <button
            onClick={() => void setStatus(conversation.id, 'CLOSED')}
            className="min-h-11 w-full rounded-lg border border-stone-300 text-sm font-medium text-stone-700 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            Cerrar conversación
          </button>
        )}
      </div>

      {contact?.notes && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-stone-500">Notas</h3>
          <p className="text-sm text-stone-700">{contact.notes}</p>
        </div>
      )}
    </div>
  );
}
