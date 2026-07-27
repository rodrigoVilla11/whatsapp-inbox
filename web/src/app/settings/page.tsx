'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, BASE_PATH } from '@/lib/api';
import { playIncomingSound, initNotifications } from '@/lib/notify';
import { type InboxPrefs, usePrefs } from '@/lib/prefs';
import { toast } from '@/lib/toast';
import type { Me } from '@/lib/types';
import { Toasts } from '@/components/Toasts';

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full items-center justify-between gap-4 rounded-xl px-3 py-2 text-left hover:bg-ceramic"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-piedra">{description}</span>
      </span>
      <span
        aria-hidden
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-nori' : 'bg-piedra/40'
        }`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-rice shadow transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  );
}

export default function InboxSettings() {
  const prefs = usePrefs((s) => s.prefs);
  const setPref = usePrefs((s) => s.setPref);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    usePrefs.getState().hydrate();
    void api.me().then(setMe).catch(() => undefined); // 401 redirige solo
    // desbloquea el AudioContext acá también (para "probar sonido")
    return initNotifications(() => undefined);
  }, []);

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      // full reload a propósito (limpia todo el estado en memoria);
      // window.location necesita el basePath explícito.
      window.location.assign(`${BASE_PATH}/login`);
    }
  }

  function setAndConfirm<K extends keyof InboxPrefs>(key: K, value: InboxPrefs[K]): void {
    setPref(key, value);
  }

  async function toggleNative(value: boolean): Promise<void> {
    if (!value) {
      setPref('nativeNotifications', false);
      return;
    }
    if (typeof Notification === 'undefined') {
      toast('Este navegador no soporta notificaciones');
      return;
    }
    const permission =
      Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
    if (permission === 'granted') {
      setPref('nativeNotifications', true);
      toast('Notificaciones activadas');
    } else {
      toast('El navegador las bloqueó — habilitalas desde el candado de la barra de direcciones');
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <header className="mb-4">
        <Link href="/" className="text-sm text-nori hover:underline">
          ← Volver al inbox
        </Link>
        <h1 className="text-xl font-semibold">Ajustes</h1>
      </header>

      <section className="mb-4 rounded-2xl border border-line bg-rice p-2">
        <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-piedra">
          Avisos
        </h2>
        <Toggle
          checked={prefs.sound}
          onChange={(v) => {
            setAndConfirm('sound', v);
            if (v) playIncomingSound(); // probarlo en el acto
          }}
          label="Sonido al llegar un mensaje"
          description="Un aviso corto y discreto, pensado para el mostrador."
        />
        <Toggle
          checked={prefs.nativeNotifications}
          onChange={(v) => void toggleNative(v)}
          label="Notificaciones del navegador"
          description="Aviso con nombre y mensaje cuando la pestaña no está a la vista."
        />
      </section>

      <section className="mb-4 rounded-2xl border border-line bg-rice p-2">
        <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-piedra">
          Escritura
        </h2>
        <Toggle
          checked={prefs.enterSends}
          onChange={(v) => setAndConfirm('enterSends', v)}
          label="Enter envía el mensaje"
          description={
            prefs.enterSends
              ? 'Enter envía; Shift+Enter hace un salto de línea.'
              : 'Enter hace un salto de línea; Ctrl+Enter envía.'
          }
        />
      </section>

      <section className="rounded-2xl border border-line bg-rice p-2">
        <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-piedra">
          Respuestas
        </h2>
        <Link
          href="/settings/quick-replies"
          className="flex min-h-14 items-center justify-between rounded-xl px-3 py-2 hover:bg-ceramic"
        >
          <span>
            <span className="block text-sm font-medium">Respuestas rápidas</span>
            <span className="block text-xs text-piedra">
              Los atajos con “/” que se insertan en el mensaje.
            </span>
          </span>
          <span aria-hidden className="text-piedra">
            ›
          </span>
        </Link>
      </section>

      <section className="mt-4 rounded-2xl border border-line bg-rice p-2">
        <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-piedra">
          Cuenta
        </h2>
        {(me?.role === 'ADMIN' || me?.role === 'OWNER') && (
          <Link
            href="/settings/users"
            className="flex min-h-14 items-center justify-between rounded-xl px-3 py-2 hover:bg-ceramic"
          >
            <span>
              <span className="block text-sm font-medium">Usuarios</span>
              <span className="block text-xs text-piedra">
                Dar de alta, cambiar roles, desactivar.
              </span>
            </span>
            <span aria-hidden className="text-piedra">
              ›
            </span>
          </Link>
        )}
        <button
          onClick={() => void logout()}
          className="flex min-h-14 w-full items-center justify-between rounded-xl px-3 py-2 text-left hover:bg-ceramic"
        >
          <span>
            <span className="block text-sm font-medium">Cerrar sesión</span>
            <span className="block text-xs text-piedra">
              {me ? `Entraste como ${me.name}` : 'Salir de este dispositivo'}
            </span>
          </span>
          <span aria-hidden className="text-piedra">
            ↪
          </span>
        </button>
      </section>

      <p className="mt-4 px-3 text-xs text-piedra">
        Estas preferencias son de este dispositivo: la tablet del mostrador y tu celular pueden
        tener ajustes distintos.
      </p>
      <Toasts />
    </main>
  );
}
