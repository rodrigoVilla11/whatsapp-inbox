'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { QuickReply } from '@/lib/types';

/** Ajustes de respuestas rápidas: lista + alta + edición + desactivar. */
export default function QuickRepliesSettings() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [editing, setEditing] = useState<QuickReply | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ shortcut: '/', title: '', body: '' });

  async function reload() {
    setItems(await api.quickReplies.list(true));
  }
  useEffect(() => {
    void reload();
  }, []);

  function startEdit(item: QuickReply | 'new') {
    setEditing(item);
    setError(null);
    setForm(
      item === 'new'
        ? { shortcut: '/', title: '', body: '' }
        : { shortcut: item.shortcut, title: item.title, body: item.body },
    );
  }

  async function save() {
    try {
      if (editing === 'new') await api.quickReplies.create(form);
      else if (editing) await api.quickReplies.update(editing.id, form);
      setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <a href="/settings" className="text-sm text-nori hover:underline">
            ← Volver a Ajustes
          </a>
          <h1 className="text-xl font-semibold">Respuestas rápidas</h1>
        </div>
        <button
          onClick={() => startEdit('new')}
          className="min-h-11 rounded-lg bg-nori px-4 text-sm font-semibold text-rice hover:bg-nori-deep"
        >
          Nueva
        </button>
      </header>

      {editing !== null && (
        <div className="mb-4 space-y-2 rounded-xl border border-line bg-rice p-4">
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-sumi/70">Atajo (empieza con /)</span>
            <input
              value={form.shortcut}
              onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value }))}
              className="min-h-11 w-full rounded-lg border border-line px-3 font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-sumi/70">Título</span>
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="min-h-11 w-full rounded-lg border border-line px-3"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-sumi/70">Texto que se inserta</span>
            <textarea
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              rows={3}
              className="w-full rounded-lg border border-line px-3 py-2"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm font-medium text-gari-ink">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(null)}
              className="min-h-11 rounded-lg px-4 text-sm text-sumi/70 hover:bg-ceramic"
            >
              Cancelar
            </button>
            <button
              onClick={() => void save()}
              className="min-h-11 flex-1 rounded-lg bg-nori text-sm font-semibold text-rice hover:bg-nori-deep"
            >
              Guardar
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-line/60 rounded-xl border border-line bg-rice">
        {items.map((q) => (
          <li key={q.id} className="flex items-center gap-3 p-3">
            <span className="font-mono text-sm font-semibold text-nori">{q.shortcut}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{q.title}</span>
              <span className="block truncate text-xs text-piedra">{q.body}</span>
            </span>
            {!q.isActive && (
              <span className="rounded-full bg-piedra-soft px-2 py-0.5 text-[11px] text-sumi/60">
                Inactiva
              </span>
            )}
            <button
              onClick={() => startEdit(q)}
              className="min-h-10 rounded-lg px-3 text-sm text-sumi/70 hover:bg-ceramic"
            >
              Editar
            </button>
            {q.isActive ? (
              <button
                onClick={() => api.quickReplies.deactivate(q.id).then(reload)}
                className="min-h-10 rounded-lg px-3 text-sm text-gari-ink hover:bg-gari-soft"
              >
                Desactivar
              </button>
            ) : (
              <button
                onClick={() => api.quickReplies.update(q.id, { isActive: true }).then(reload)}
                className="min-h-10 rounded-lg px-3 text-sm text-nori hover:bg-nori-soft"
              >
                Activar
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="p-6 text-center text-sm text-piedra">Sin respuestas rápidas</li>
        )}
      </ul>
    </main>
  );
}
