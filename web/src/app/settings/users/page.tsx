'use client';

import { useEffect, useState } from 'react';
import { Toasts } from '@/components/Toasts';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { ManagedUser, Me } from '@/lib/types';

const ROLE_LABEL: Record<ManagedUser['role'], string> = {
  OWNER: 'Dueño',
  ADMIN: 'Encargado',
  AGENT: 'Agente',
};

/**
 * Alta y gestión mínima de usuarios (ADMIN+). La password inicial la
 * comunica el admin por su cuenta; el sistema fuerza el cambio en el
 * primer login. El backend es la autoridad de la matriz — acá solo se
 * esconden botones.
 */
export default function UsersSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'AGENT', password: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reload(): Promise<void> {
    const [meData, list] = await Promise.all([api.me(), api.users.manage()]);
    setMe(meData);
    setUsers(list);
    setLoaded(true);
  }
  useEffect(() => {
    reload().catch(() => setLoaded(true)); // 401 redirige solo (api.ts)
  }, []);

  const canManage = me?.role === 'ADMIN' || me?.role === 'OWNER';

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setFormError(null);
    try {
      await api.users.create(form);
      setCreating(false);
      setForm({ name: '', email: '', role: 'AGENT', password: '' });
      toast('Usuario creado — pasale la contraseña inicial');
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo crear');
    } finally {
      setPending(false);
    }
  }

  async function setActive(user: ManagedUser, isActive: boolean): Promise<void> {
    try {
      await api.users.update(user.id, { isActive });
      toast(isActive ? `${user.name} reactivado` : `${user.name} desactivado — sesiones cerradas`);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'No se pudo actualizar');
    }
  }

  async function setRole(user: ManagedUser, role: string): Promise<void> {
    try {
      await api.users.update(user.id, { role });
      toast(`${user.name} ahora es ${ROLE_LABEL[role as ManagedUser['role']]}`);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'No se pudo cambiar el rol');
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <header className="mb-4 flex items-end justify-between">
        <div>
          <a href="/settings" className="text-sm text-nori hover:underline">
            ← Volver a Ajustes
          </a>
          <h1 className="text-xl font-semibold">Usuarios</h1>
        </div>
        {canManage && (
          <button
            onClick={() => setCreating((v) => !v)}
            className="min-h-11 rounded-xl bg-nori px-4 text-sm font-semibold text-rice hover:bg-nori-deep"
          >
            {creating ? 'Cancelar' : 'Nuevo usuario'}
          </button>
        )}
      </header>

      {loaded && !canManage && (
        <p className="rounded-2xl border border-line bg-rice p-4 text-sm text-piedra">
          Esta sección es para administradores. Si necesitás un usuario nuevo, pedíselo a quien
          administra el inbox.
        </p>
      )}

      {creating && canManage && (
        <form onSubmit={create} className="mb-4 space-y-2 rounded-2xl border border-line bg-rice p-4">
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-sumi/70">Nombre</span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="min-h-11 w-full rounded-xl border border-line px-3"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-sumi/70">Email</span>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="min-h-11 w-full rounded-xl border border-line px-3"
            />
          </label>
          <div className="flex gap-2">
            <label className="block flex-1 text-sm">
              <span className="mb-0.5 block text-xs text-sumi/70">Rol</span>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                className="min-h-11 w-full rounded-xl border border-line bg-rice px-3"
              >
                <option value="AGENT">Agente</option>
                {me?.role === 'OWNER' && <option value="ADMIN">Encargado</option>}
              </select>
            </label>
            <label className="block flex-1 text-sm">
              <span className="mb-0.5 block text-xs text-sumi/70">Contraseña inicial (10+)</span>
              <input
                required
                minLength={10}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                className="min-h-11 w-full rounded-xl border border-line px-3 font-mono"
              />
            </label>
          </div>
          <p className="text-xs text-piedra">
            Pasale esta contraseña en persona: el sistema le va a pedir elegir una propia al entrar.
          </p>
          {formError && (
            <p role="alert" className="text-sm font-medium text-gari-ink">
              {formError}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 w-full rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep disabled:opacity-50"
          >
            {pending ? 'Creando…' : 'Crear usuario'}
          </button>
        </form>
      )}

      {canManage && (
        <ul className="divide-y divide-line/60 rounded-2xl border border-line bg-rice">
          {users.map((u) => {
            const isSelf = u.id === me?.userId;
            const editable =
              u.role !== 'OWNER' && (me?.role === 'OWNER' || u.role === 'AGENT') && !isSelf;
            return (
              <li key={u.id} className={`flex items-center gap-3 p-3 ${u.isActive ? '' : 'opacity-60'}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {u.name}
                    {isSelf && <span className="text-piedra"> (vos)</span>}
                  </span>
                  <span className="block truncate text-xs text-piedra">{u.email}</span>
                </span>
                {u.mustChangePassword && u.isActive && (
                  <span className="rounded-full bg-nori-soft px-2 py-0.5 text-[11px] text-nori">
                    aún no entró
                  </span>
                )}
                {me?.role === 'OWNER' && editable ? (
                  <select
                    aria-label={`Rol de ${u.name}`}
                    value={u.role}
                    onChange={(e) => void setRole(u, e.target.value)}
                    className="min-h-10 rounded-xl border border-line bg-rice px-2 text-xs"
                  >
                    <option value="AGENT">Agente</option>
                    <option value="ADMIN">Encargado</option>
                  </select>
                ) : (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-sumi/70">
                    {ROLE_LABEL[u.role]}
                  </span>
                )}
                {editable &&
                  (u.isActive ? (
                    <button
                      onClick={() => void setActive(u, false)}
                      className="min-h-10 rounded-xl px-3 text-sm text-gari-ink hover:bg-gari-soft"
                    >
                      Desactivar
                    </button>
                  ) : (
                    <button
                      onClick={() => void setActive(u, true)}
                      className="min-h-10 rounded-xl px-3 text-sm text-nori hover:bg-nori-soft"
                    >
                      Reactivar
                    </button>
                  ))}
              </li>
            );
          })}
          {users.length === 0 && loaded && (
            <li className="p-6 text-center text-sm text-piedra">Sin usuarios todavía.</li>
          )}
        </ul>
      )}
      <Toasts />
    </main>
  );
}
