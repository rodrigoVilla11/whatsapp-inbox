'use client';

import { create } from 'zustand';

/**
 * Estado del visor de imágenes a pantalla completa.
 *
 * Store propio (como los toasts) y no estado en InboxShell: la imagen se
 * abre desde MessageBubble, que está varios niveles abajo, y prop-drillear
 * un abridor a través de Thread para esto no paga.
 */
export interface LightboxImage {
  /** URL del endpoint de media (302 → URL firmada de TTL corto). */
  url: string;
  alt: string;
  /** Nombre del archivo si el mensaje trae uno; null si no. */
  filename: string | null;
}

interface LightboxState {
  image: LightboxImage | null;
  open(image: LightboxImage): void;
  close(): void;
}

export const useLightbox = create<LightboxState>()((set) => ({
  image: null,
  open(image) {
    set({ image });
  },
  close() {
    set({ image: null });
  },
}));
