'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useInbox } from '@/lib/store';

/**
 * Interstitial de cambio forzado (mustChangePassword): el usuario entró
 * con la password inicial que le pasó el admin y no ve el inbox hasta
 * elegir la definitiva. También cierra las demás sesiones (server-side).
 */
export function ChangePasswordGate() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (next !== repeat) {
      setError('Las contraseñas nuevas no coinciden');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.auth.changePassword(current, next);
      useInbox.setState((s) => ({
        me: s.me ? { ...s.me, mustChangePassword: false } : s.me,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar — probá de nuevo');
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ceramic p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-2xl border border-line bg-rice p-5 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold">Elegí tu contraseña</h1>
          <p className="mt-1 text-sm text-piedra">
            La que te dieron era provisoria. Poné una tuya (mínimo 10 caracteres) y listo.
          </p>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-sumi/70">Contraseña actual</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-line bg-rice px-3 text-[15px]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-sumi/70">Contraseña nueva</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-line bg-rice px-3 text-[15px]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-sumi/70">Repetila</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-line bg-rice px-3 text-[15px]"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-xl bg-gari-soft px-3 py-2 text-sm font-medium text-gari-ink">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="min-h-12 w-full rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep disabled:opacity-50"
        >
          {pending ? 'Guardando…' : 'Guardar y entrar'}
        </button>
      </form>
    </main>
  );
}
