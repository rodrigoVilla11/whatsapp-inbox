import { create } from 'zustand';

/**
 * Preferencias DE DISPOSITIVO (no de dominio): viven en localStorage a
 * propósito — el sonido de la tablet del mostrador y el hábito de Enter
 * del dueño en su celu son cosas distintas y no deben pisarse.
 */
export interface InboxPrefs {
  /** Sonido corto al llegar un mensaje entrante. */
  sound: boolean;
  /** Notificaciones nativas del navegador (opt-in explícito). */
  nativeNotifications: boolean;
  /** true: Enter envía / Shift+Enter salto. false: Enter salto / Ctrl+Enter envía. */
  enterSends: boolean;
}

export const DEFAULT_PREFS: InboxPrefs = {
  sound: true,
  nativeNotifications: false,
  enterSends: true,
};

export const PREFS_STORAGE_KEY = 'inbox:prefs';

/** Parseo tolerante: default + override campo a campo; basura → defaults. */
export function parsePrefs(raw: string | null): InboxPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ...DEFAULT_PREFS };
  }
  const d = data as Record<string, unknown>;
  return {
    sound: typeof d.sound === 'boolean' ? d.sound : DEFAULT_PREFS.sound,
    nativeNotifications:
      typeof d.nativeNotifications === 'boolean'
        ? d.nativeNotifications
        : DEFAULT_PREFS.nativeNotifications,
    enterSends: typeof d.enterSends === 'boolean' ? d.enterSends : DEFAULT_PREFS.enterSends,
  };
}

interface PrefsState {
  prefs: InboxPrefs;
  hydrated: boolean;
  /** Carga desde localStorage — en useEffect, nunca en render (SSR). */
  hydrate(): void;
  setPref<K extends keyof InboxPrefs>(key: K, value: InboxPrefs[K]): void;
}

export const usePrefs = create<PrefsState>()((set, get) => ({
  prefs: DEFAULT_PREFS,
  hydrated: false,

  hydrate() {
    if (get().hydrated || typeof localStorage === 'undefined') return;
    set({ prefs: parsePrefs(localStorage.getItem(PREFS_STORAGE_KEY)), hydrated: true });
  },

  setPref(key, value) {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    }
  },
}));
