'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TagChip } from '@/components/TagChip';
import { Toasts } from '@/components/Toasts';
import { api } from '@/lib/api';
import { DEFAULT_TAG_COLOR, TAG_COLORS, tagSwatchClass } from '@/lib/tag-colors';
import { toast } from '@/lib/toast';
import type { Tag } from '@/lib/types';

/**
 * Ajustes de etiquetas (ADMIN+). Acá NO se crean etiquetas nuevas de la nada:
 * nacen en el chat, donde se necesitan. Esta pantalla es para ordenar lo que
 * se acumuló — renombrar, dar color y borrar lo que no se usa.
 */
export default function TagsSettings() {
  const [items, setItems] = useState<Tag[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; color: string }>({
    name: '',
    color: DEFAULT_TAG_COLOR,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload(): Promise<void> {
    setItems(await api.tags.list());
    setLoading(false);
  }
  useEffect(() => {
    void reload().catch(() => setLoading(false));
  }, []);

  function startEdit(tag: Tag): void {
    setEditingId(tag.id);
    setForm({ name: tag.name, color: tag.color });
    setError(null);
  }

  async function save(): Promise<void> {
    if (!editingId) return;
    try {
      await api.tags.update(editingId, { name: form.name, color: form.color });
      setEditingId(null);
      await reload();
      toast('Etiqueta guardada');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    }
  }

  async function remove(tag: Tag): Promise<void> {
    const used = tag.usageCount ?? 0;
    const warning = used > 0 ? `\n\nSe va a quitar de ${used} conversación(es).` : '';
    if (!window.confirm(`¿Borrar la etiqueta “${tag.name}”?${warning}`)) return;
    try {
      await api.tags.remove(tag.id);
      await reload();
      toast('Etiqueta borrada');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo borrar');
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <header className="mb-4">
        <Link href="/settings" className="text-sm text-nori hover:underline">
          ← Volver a Ajustes
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Etiquetas</h1>
        <p className="mt-1 text-xs text-piedra">
          Las etiquetas se crean desde el chat, en el panel del contacto. Acá se renombran, se
          les cambia el color y se borran.
        </p>
      </header>

      {loading && <p className="text-sm text-piedra">Cargando…</p>}

      {!loading && items.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-piedra">
          Todavía no hay etiquetas. Abrí un chat y creá la primera desde el panel del contacto.
        </p>
      )}

      <ul className="space-y-2">
        {items.map((tag) => (
          <li key={tag.id} className="rounded-2xl border border-line bg-rice p-3">
            {editingId === tag.id ? (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor={`tag-name-${tag.id}`}
                    className="mb-1 block text-xs font-medium text-piedra"
                  >
                    Nombre
                  </label>
                  <input
                    id={`tag-name-${tag.id}`}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    maxLength={24}
                    className="min-h-11 w-full rounded-xl border border-line px-3 text-sm"
                  />
                </div>

                <div>
                  <span className="mb-1 block text-xs font-medium text-piedra">Color</span>
                  <div className="flex flex-wrap gap-2">
                    {TAG_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, color }))}
                        aria-label={`Color ${color}`}
                        aria-pressed={form.color === color}
                        className={`h-9 w-9 rounded-full ${tagSwatchClass(color)} ${
                          form.color === color ? 'ring-2 ring-sumi ring-offset-2' : ''
                        }`}
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <p role="alert" className="text-xs font-medium text-gari-ink">
                    {error}
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => void save()}
                    className="min-h-11 flex-1 rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep"
                  >
                    Guardar
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setError(null);
                    }}
                    className="min-h-11 flex-1 rounded-xl border border-line text-sm font-medium hover:bg-ceramic"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <TagChip tag={tag} />
                  <span className="mt-1 block text-xs text-piedra">
                    {tag.usageCount === 0
                      ? 'Sin usar'
                      : `En ${tag.usageCount} conversación${tag.usageCount === 1 ? '' : 'es'}`}
                  </span>
                </span>
                <button
                  onClick={() => startEdit(tag)}
                  className="min-h-11 shrink-0 rounded-xl px-3 text-sm font-medium text-nori hover:bg-nori-soft"
                >
                  Editar
                </button>
                <button
                  onClick={() => void remove(tag)}
                  className="min-h-11 shrink-0 rounded-xl px-3 text-sm font-medium text-gari-ink hover:bg-gari-soft"
                >
                  Borrar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <Toasts />
    </main>
  );
}
