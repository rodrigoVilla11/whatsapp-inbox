'use client';

import { useState } from 'react';
import { useInbox } from '@/lib/store';
import { toast } from '@/lib/toast';
import type { Conversation } from '@/lib/types';
import { usePending } from '@/lib/use-pending';

/**
 * Selector de agente en el header del hilo. "Asignármela" es la acción de
 * un tap; el resto de los agentes, debajo. Nombres reales (GET /users).
 */
export function AssignMenu({ conversation }: { conversation: Conversation }) {
  const users = useInbox((s) => s.users);
  const me = useInbox((s) => s.me);
  const assign = useInbox((s) => s.assign);
  const [open, setOpen] = useState(false);
  const { pending, run } = usePending();

  const assignedUser = conversation.assignedUserId
    ? (users.find((u) => u.id === conversation.assignedUserId) ?? null)
    : null;
  const mine = !!me?.userId && conversation.assignedUserId === me.userId;
  const label = conversation.assignedUserId
    ? mine
      ? 'Vos'
      : (assignedUser?.name ?? 'Asignada')
    : 'Asignar';

  function doAssign(userId: string | null, confirmation: string) {
    setOpen(false);
    run(async () => {
      await assign(conversation.id, userId);
      toast(confirmation);
    });
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`min-h-11 max-w-36 truncate rounded-xl border px-3 text-sm font-medium disabled:opacity-50 ${
          mine
            ? 'border-nori bg-nori-soft text-nori'
            : 'border-line bg-rice text-sumi/80 hover:bg-ceramic'
        }`}
      >
        {pending ? 'Guardando…' : `${label} ▾`}
      </button>

      {open && (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            role="menu"
            aria-label="Asignar conversación"
            className="absolute right-0 top-full z-30 mt-1 w-56 rounded-2xl border border-line bg-rice p-1 shadow-lg"
          >
            {me?.userId && !mine && (
              <li role="none">
                <button
                  role="menuitem"
                  onClick={() => doAssign(me.userId, 'Asignada a vos')}
                  className="min-h-11 w-full rounded-xl px-3 text-left text-sm font-semibold text-nori hover:bg-nori-soft"
                >
                  Asignármela
                </button>
              </li>
            )}
            {users
              .filter((u) => u.id !== me?.userId && u.id !== conversation.assignedUserId)
              .map((u) => (
                <li role="none" key={u.id}>
                  <button
                    role="menuitem"
                    onClick={() => doAssign(u.id, `Asignada a ${u.name}`)}
                    className="min-h-11 w-full truncate rounded-xl px-3 text-left text-sm hover:bg-ceramic"
                  >
                    {u.name}
                  </button>
                </li>
              ))}
            {conversation.assignedUserId && (
              <li role="none">
                <button
                  role="menuitem"
                  onClick={() => doAssign(null, 'Conversación liberada')}
                  className="min-h-11 w-full rounded-xl px-3 text-left text-sm text-sumi/70 hover:bg-ceramic"
                >
                  Liberar
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
