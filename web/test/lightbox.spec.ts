// @vitest-environment jsdom
/**
 * Visor de imágenes: la burbuja abre, el visor muestra y cierra.
 *
 * El caso que importa es el del mostrador: una foto de comprobante llega
 * chica en el hilo (max-h-64) y hay que poder verla grande y a tamaño real.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lightbox } from '../src/components/Lightbox';
import { MessageBubble } from '../src/components/MessageBubble';
import { useLightbox } from '../src/lib/lightbox';
import { useInbox } from '../src/lib/store';
import type { Message } from '../src/lib/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function imageMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    wamid: 'wamid.1',
    clientDedupKey: null,
    direction: 'INBOUND',
    type: 'IMAGE',
    status: 'DELIVERED',
    body: null,
    replyToWamid: null,
    templateName: null,
    templateLanguage: null,
    mediaMimeType: 'image/jpeg',
    mediaFilename: 'comprobante.jpg',
    mediaSizeBytes: 51_200,
    mediaStatus: 'DOWNLOADED',
    transcription: null,
    isAutoReply: false,
    errorCode: null,
    errorTitle: null,
    errorDetail: null,
    sentByUserId: null,
    timestamp: '2026-07-29T18:08:00Z',
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    createdAt: '2026-07-29T18:08:00Z',
    ...overrides,
  };
}

let cleanups: Array<() => void> = [];

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  useLightbox.setState({ image: null });
  useInbox.setState({ timezone: 'UTC', users: [] });
  cleanups = [];
});

afterEach(() => {
  for (const c of cleanups) c();
});

describe('store del visor', () => {
  it('open guarda la imagen y close la limpia', () => {
    const image = { url: '/api/messages/m1/media', alt: 'Imagen recibida', filename: 'f.jpg' };
    useLightbox.getState().open(image);
    expect(useLightbox.getState().image).toEqual(image);
    useLightbox.getState().close();
    expect(useLightbox.getState().image).toBeNull();
  });
});

describe('MessageBubble → visor', () => {
  it('la imagen del hilo es un botón accesible que abre el visor', async () => {
    const container = await render(
      React.createElement(MessageBubble, { message: imageMessage() }),
    );

    const button = container.querySelector('button[aria-label^="Ver más grande"]');
    expect(button).not.toBeNull();
    expect(useLightbox.getState().image).toBeNull();

    await click(button as Element);

    const image = useLightbox.getState().image;
    expect(image?.filename).toBe('comprobante.jpg');
    expect(image?.url).toContain('/messages/m1/media');
  });

  it('usa el caption como alt cuando lo hay, y la dirección cuando no', async () => {
    const conCaption = await render(
      React.createElement(MessageBubble, { message: imageMessage({ body: 'el CBU' }) }),
    );
    expect(conCaption.querySelector('img')?.getAttribute('alt')).toBe('el CBU');

    const saliente = await render(
      React.createElement(MessageBubble, {
        message: imageMessage({ direction: 'OUTBOUND', body: null }),
      }),
    );
    expect(saliente.querySelector('img')?.getAttribute('alt')).toBe('Imagen enviada');
  });

  it('media que NO está DOWNLOADED no es clickeable (no hay nada que agrandar)', async () => {
    const container = await render(
      React.createElement(MessageBubble, { message: imageMessage({ mediaStatus: 'PENDING' }) }),
    );
    expect(container.querySelector('button[aria-label^="Ver más grande"]')).toBeNull();
  });
});

describe('Lightbox', () => {
  it('sin imagen no renderiza nada', async () => {
    const container = await render(React.createElement(Lightbox));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('con imagen muestra el diálogo, el nombre y la imagen a tamaño ajustado', async () => {
    useLightbox.getState().open({
      url: '/api/messages/m1/media',
      alt: 'Imagen recibida',
      filename: 'comprobante.jpg',
    });
    const container = await render(React.createElement(Lightbox));

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(container.textContent).toContain('comprobante.jpg');

    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/messages/m1/media');
    // arranca ajustado a la pantalla
    expect(img?.className).toContain('object-contain');
    expect(img?.className).not.toContain('max-w-none');
  });

  it('el tap en la imagen alterna a tamaño real y vuelve', async () => {
    useLightbox.getState().open({ url: '/u', alt: 'a', filename: null });
    const container = await render(React.createElement(Lightbox));
    const img = container.querySelector('img') as Element;

    await click(img);
    expect(container.querySelector('img')?.className).toContain('max-w-none');

    await click(container.querySelector('img') as Element);
    expect(container.querySelector('img')?.className).toContain('object-contain');
  });

  it('el botón de cerrar limpia el store', async () => {
    useLightbox.getState().open({ url: '/u', alt: 'a', filename: null });
    const container = await render(React.createElement(Lightbox));

    await click(container.querySelector('button[aria-label="Cerrar el visor"]') as Element);
    expect(useLightbox.getState().image).toBeNull();
  });

  it('el click en el fondo cierra, pero el click en la imagen NO', async () => {
    useLightbox.getState().open({ url: '/u', alt: 'a', filename: null });
    const container = await render(React.createElement(Lightbox));

    // la imagen no debe cerrar (alterna el zoom)
    await click(container.querySelector('img') as Element);
    expect(useLightbox.getState().image).not.toBeNull();

    // el fondo sí
    await click(container.querySelector('[role="dialog"]') as Element);
    expect(useLightbox.getState().image).toBeNull();
  });

  it('sin filename muestra un rótulo genérico, no "null"', async () => {
    useLightbox.getState().open({ url: '/u', alt: 'a', filename: null });
    const container = await render(React.createElement(Lightbox));
    expect(container.textContent).toContain('Imagen');
    expect(container.textContent).not.toContain('null');
  });
});
