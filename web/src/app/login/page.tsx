'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

/** Solo paths internos: nada de ?next=https://otro-lado (open redirect). */
function safeNext(): string {
  if (typeof window === 'undefined') return '/inbox';
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/inbox';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api.auth.login(email, password);
      router.replace(safeNext()); // si debe cambiar password, el inbox lo intercepta
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión — probá de nuevo');
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* La firma de la casa también acá: la barra, en reposo */}
        <div className="mb-6 text-center">
          <div aria-hidden className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-nori text-xl font-semibold text-rice">
            N
          </div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-piedra">El WhatsApp del mostrador, ordenado.</p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-3 rounded-2xl border border-line bg-rice p-5 shadow-sm"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sumi/70">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-12 w-full rounded-xl border border-line bg-rice px-3 text-[15px]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sumi/70">Contraseña</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            {pending ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <div aria-hidden className="mx-auto mt-6 h-1.5 w-24 overflow-hidden rounded-full bg-nori-soft">
          <div className="h-full w-2/3 rounded-full bg-nori" />
        </div>
      </div>
    </main>
  );
}
