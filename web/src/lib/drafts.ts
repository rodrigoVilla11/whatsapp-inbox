'use client';

import { create } from 'zustand';

/**
 * Borradores por conversación — DE ESTE DISPOSITIVO (localStorage, como
 * las preferencias): lo que la cajera dejó a medias en la tablet no tiene
 * por qué aparecer en el celu del dueño. Texto vacío = borrador borrado.
 */

export const DRAFTS_STORAGE_KEY = 'inbox:drafts';

/** Parseo tolerante: basura → {}; solo strings con contenido. */
export function parseDrafts(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
  const drafts: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.trim()) drafts[key] = value;
  }
  return drafts;
}

interface DraftsState {
  drafts: Record<string, string>;
  hydrated: boolean;
  /** En useEffect, nunca en render (SSR + hydration). */
  hydrate(): void;
  /** text vacío/espacios = borrar el borrador. */
  setDraft(conversationId: string, text: string): void;
}

export const useDrafts = create<DraftsState>()((set, get) => ({
  drafts: {},
  hydrated: false,

  hydrate() {
    if (get().hydrated || typeof localStorage === 'undefined') return;
    set({ drafts: parseDrafts(localStorage.getItem(DRAFTS_STORAGE_KEY)), hydrated: true });
  },

  setDraft(conversationId, text) {
    const current = get().drafts;
    const has = text.trim().length > 0;
    if (!has && current[conversationId] === undefined) return; // nada que borrar
    if (has && current[conversationId] === text) return; // sin cambios

    const drafts = { ...current };
    if (has) drafts[conversationId] = text;
    else delete drafts[conversationId];
    set({ drafts });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
    }
  },
}));
