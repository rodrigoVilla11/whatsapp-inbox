'use client';

import { useState } from 'react';
import { useLightbox } from '@/lib/lightbox';

/**
 * Visor de imágenes a pantalla completa.
 *
 * La burbuja del hilo las muestra chicas (max-h-64) y así un comprobante de
 * transferencia no se lee: el caso real del mostrador es leer un CBU o un
 * monto de una foto que mandó el cliente.
 *
 * DOS tamaños, no un zoom continuo: "entra en pantalla" y "tamaño real" con
 * scroll. Es lo que resuelve el caso sin pedirle a la cajera un gesto fino
 * de pinch en la tablet — y el tap en la imagen alterna entre los dos.
 *
 * El Esc lo maneja InboxShell, que tiene la cadena de precedencia de Escape
 * (el visor va primero: es lo que está más arriba).
 */
export function Lightbox() {
  const image = useLightbox((s) => s.image);
  const close = useLightbox((s) => s.close);
  const [zoomed, setZoomed] = useState(false);

  if (!image) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Visor de imagen"
      className="fixed inset-0 z-50 flex flex-col bg-sumi/95"
      onClick={close} // click en el fondo cierra
    >
      <div
        className="flex shrink-0 items-center gap-1 px-2 py-2"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-rice/90">
          {image.filename ?? 'Imagen'}
        </span>
        <button
          type="button"
          onClick={() => setZoomed((v) => !v)}
          className="min-h-11 rounded-xl px-3 text-sm font-medium text-rice/90 hover:bg-white/10"
        >
          {zoomed ? 'Ajustar' : 'Tamaño real'}
        </button>
        <a
          href={image.url}
          target="_blank"
          rel="noreferrer"
          download={image.filename ?? undefined}
          className="flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-rice/90 hover:bg-white/10"
        >
          Descargar
        </a>
        <button
          type="button"
          onClick={close}
          aria-label="Cerrar el visor"
          autoFocus
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg text-rice/90 hover:bg-white/10"
        >
          ✕
        </button>
      </div>

      {/* En "tamaño real" el contenedor scrollea para recorrer la imagen; en
          "ajustar" la imagen entra completa y queda centrada. */}
      <div
        className={`flex-1 p-2 ${
          zoomed ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.url}
          alt={image.alt}
          onClick={() => setZoomed((v) => !v)}
          className={
            zoomed
              ? 'max-w-none cursor-zoom-out'
              : 'max-h-full max-w-full cursor-zoom-in object-contain'
          }
        />
      </div>
    </div>
  );
}
