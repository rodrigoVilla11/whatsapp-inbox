'use client';

import { useMemo, useState } from 'react';
import { useInbox } from '@/lib/store';
import { tagChipClass } from '@/lib/tag-colors';
import type { Tag } from '@/lib/types';
import { TagChip } from './TagChip';

/** Espejo del tope del backend (MAX_TAGS_PER_CONVERSATION). */
const MAX_TAGS = 6;

/**
 * Etiquetas de la conversación en el panel de contacto.
 *
 * Filosofía (decidida con el usuario): cualquier agente puede crear una
 * etiqueta escribiéndola acá mismo — en el mostrador no se puede parar a ir
 * a Ajustes. El color y el orden se manejan después desde Ajustes (ADMIN+).
 *
 * El input hace doble función: filtra las existentes mientras se tipea, y si
 * no hay ninguna igual ofrece crear la que se escribió.
 */
export function TagPicker({ conversationId }: { conversationId: string }) {
  const applied = useInbox(
    (s) => s.conversations.find((c) => c.id === conversationId)?.tags ?? EMPTY,
  );
  const allTags = useInbox((s) => s.tags);
  const setConversationTags = useInbox((s) => s.setConversationTags);
  const createTag = useInbox((s) => s.createTag);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const appliedIds = useMemo(() => new Set(applied.map((t) => t.id)), [applied]);
  const q = query.trim().toLowerCase();

  const suggestions = useMemo(
    () =>
      allTags
        .filter((t) => !appliedIds.has(t.id))
        .filter((t) => (q ? t.name.toLowerCase().includes(q) : true))
        .slice(0, 8),
    [allTags, appliedIds, q],
  );

  // Ofrecer crear solo si lo tipeado no coincide EXACTO con algo que ya existe
  // (ni aplicado ni sugerido): si existe, se aplica, no se duplica.
  const exact = allTags.find((t) => t.name.toLowerCase() === q);
  const canCreate = q.length > 0 && !exact;
  const atLimit = applied.length >= MAX_TAGS;

  async function apply(tag: Tag): Promise<void> {
    if (atLimit) return;
    setBusy(true);
    await setConversationTags(conversationId, [...applied.map((t) => t.id), tag.id]);
    setBusy(false);
    setQuery('');
  }

  async function remove(tagId: string): Promise<void> {
    setBusy(true);
    await setConversationTags(
      conversationId,
      applied.filter((t) => t.id !== tagId).map((t) => t.id),
    );
    setBusy(false);
  }

  async function createAndApply(): Promise<void> {
    if (!canCreate || atLimit) return;
    setBusy(true);
    const tag = await createTag(query.trim());
    if (tag) {
      // create es buscar-o-crear: si ya estaba aplicada, no la repite.
      if (!appliedIds.has(tag.id)) {
        await setConversationTags(conversationId, [...applied.map((t) => t.id), tag.id]);
      }
      setQuery('');
    }
    setBusy(false);
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-piedra">Etiquetas</h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="min-h-8 rounded-lg px-2 text-[11px] font-medium text-nori hover:bg-nori-soft"
        >
          {open ? 'Listo' : '+ Etiquetar'}
        </button>
      </div>

      {applied.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {applied.map((tag) => (
            <TagChip
              key={tag.id}
              tag={tag}
              onRemove={open && !busy ? () => void remove(tag.id) : undefined}
            />
          ))}
        </div>
      ) : (
        !open && <p className="text-[11px] text-piedra">Sin etiquetas</p>
      )}

      {open && (
        <div className="mt-2 space-y-2">
          {atLimit ? (
            <p className="text-[11px] font-medium text-gari-ink">
              Llegaste a {MAX_TAGS} etiquetas — sacá una para agregar otra.
            </p>
          ) : (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  // Enter aplica la primera sugerencia; si no hay, crea.
                  if (suggestions.length > 0) void apply(suggestions[0]);
                  else void createAndApply();
                }}
                maxLength={24}
                placeholder="Buscar o crear etiqueta…"
                aria-label="Buscar o crear etiqueta"
                className="min-h-11 w-full rounded-xl border border-line bg-rice px-3 text-sm placeholder:text-piedra"
              />

              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((tag) => (
                  <TagChip key={tag.id} tag={tag} onClick={() => void apply(tag)} />
                ))}
                {canCreate && (
                  <button
                    type="button"
                    onClick={() => void createAndApply()}
                    disabled={busy}
                    className={`inline-flex min-h-8 items-center gap-1 rounded-full border border-dashed border-piedra px-2 py-0.5 text-[11px] font-medium text-sumi/80 hover:bg-ceramic disabled:opacity-50 ${tagChipClass(
                      'piedra',
                    )}`}
                  >
                    + Crear “{query.trim()}”
                  </button>
                )}
                {suggestions.length === 0 && !canCreate && (
                  <p className="text-[11px] text-piedra">
                    {allTags.length === 0
                      ? 'Todavía no hay etiquetas — escribí una para crearla.'
                      : 'Ya están todas aplicadas.'}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Referencia estable: un `?? []` inline rompería el getSnapshot de zustand. */
const EMPTY: Tag[] = [];
