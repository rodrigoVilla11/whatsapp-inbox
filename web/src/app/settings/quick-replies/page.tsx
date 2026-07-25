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
          <a href="/inbox" className="text-sm text-emerald-700 hover:underline">
            ← Volver al inbox
          </a>
          <h1 className="text-xl font-bold">Respuestas rápidas</h1>
        </div>
        <button
          onClick={() => startEdit('new')}
          className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-800"
        >
          Nueva
        </button>
      </header>

      {editing !== null && (
        <div className="mb-4 space-y-2 rounded-xl border border-stone-200 bg-white p-4">
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-stone-600">Atajo (empieza con /)</span>
            <input
              value={form.shortcut}
              onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value }))}
              className="min-h-11 w-full rounded-lg border border-stone-300 px-3 font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-stone-600">Título</span>
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="min-h-11 w-full rounded-lg border border-stone-300 px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-0.5 block text-xs text-stone-600">Texto que se inserta</span>
            <textarea
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              rows={3}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm font-medium text-red-600">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(null)}
              className="min-h-11 rounded-lg px-4 text-sm text-stone-600 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            >
              Cancelar
            </button>
            <button
              onClick={() => void save()}
              className="min-h-11 flex-1 rounded-lg bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-800"
            >
              Guardar
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white">
        {items.map((q) => (
          <li key={q.id} className="flex items-center gap-3 p-3">
            <span className="font-mono text-sm font-semibold text-emerald-700">{q.shortcut}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{q.title}</span>
              <span className="block truncate text-xs text-stone-500">{q.body}</span>
            </span>
            {!q.isActive && (
              <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] text-stone-600">
                Inactiva
              </span>
            )}
            <button
              onClick={() => startEdit(q)}
              className="min-h-10 rounded-lg px-3 text-sm text-stone-600 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            >
              Editar
            </button>
            {q.isActive ? (
              <button
                onClick={() => api.quickReplies.deactivate(q.id).then(reload)}
                className="min-h-10 rounded-lg px-3 text-sm text-red-600 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600"
              >
                Desactivar
              </button>
            ) : (
              <button
                onClick={() => api.quickReplies.update(q.id, { isActive: true }).then(reload)}
                className="min-h-10 rounded-lg px-3 text-sm text-emerald-700 hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
              >
                Activar
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="p-6 text-center text-sm text-stone-400">Sin respuestas rápidas</li>
        )}
      </ul>
    </main>
  );
}
