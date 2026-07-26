'use client';

import { create } from 'zustand';

/** Toasts de confirmación de acciones (asignar, cerrar, copiar). */

export interface ToastItem {
  id: number;
  text: string;
}

const AUTO_DISMISS_MS = 3500;
let seq = 0;

interface ToastState {
  toasts: ToastItem[];
  push(text: string): void;
  dismiss(id: number): void;
}

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push(text) {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text }] }));
    setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(text: string): void {
  useToasts.getState().push(text);
}
