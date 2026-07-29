// @vitest-environment jsdom
/**
 * Reproducción REAL del bug de getSnapshot: renderiza <Thread> bajo
 * StrictMode (que evalúa getSnapshot dos veces) con el estado exacto del
 * bug reportado — conversación existente SIN mensajes cargados.
 *
 * Incluye un test de SENSIBILIDAD: un componente con el patrón viejo
 * (`?? []` inline) DEBE disparar el error — si ese test fallara, el verde
 * del resto no probaría nada.
 */
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thread } from '../src/components/Thread';
import { useInbox } from '../src/lib/store';
import type { Conversation } from '../src/lib/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conversationFixture: Conversation = {
  id: 'c1',
  contactId: 'ct1',
  whatsappAccountId: 'a1',
  status: 'OPEN',
  assignedUserId: null,
  unreadCount: 0,
  lastInboundAt: new Date().toISOString(),
  lastOutboundAt: null,
  lastMessageAt: new Date().toISOString(),
  lastMessagePreview: 'hola',
  pinnedAt: null,
  createdAt: new Date().toISOString(),
  isWindowOpen: true,
  windowExpiresAt: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
  contact: { id: 'ct1', waId: '549341', phoneE164: '+549341', profileName: 'Juan', notes: null, isBlocked: false },
};

let errors: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  useInbox.setState({
    conversations: [conversationFixture],
    messages: {}, // ← el estado del bug: hilo abierto por primera vez, sin mensajes
    messagesCursor: {},
    timezone: 'UTC',
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

async function render(element: React.ReactElement): Promise<() => void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(StrictMode, null, element));
    });
  } catch {
    // el loop infinito termina en throw ("Maximum update depth"): lo que
    // importa para el assert es lo capturado en console.error
  }
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

const sawSnapshotLoop = (): boolean =>
  errors.some((e) => e.includes('getSnapshot') || e.includes('Maximum update depth'));

describe('sensibilidad del harness', () => {
  it('el patrón VIEJO (`?? []` inline en el selector) dispara el loop', async () => {
    function Buggy(): null {
      useInbox((s) => s.messages['inexistente'] ?? []); // el bug original, a propósito
      return null;
    }
    const cleanup = await render(React.createElement(Buggy));
    expect(sawSnapshotLoop()).toBe(true); // si esto falla, el harness no detecta nada
    cleanup();
  });
});

describe('Thread con el fix', () => {
  it('montar un hilo SIN mensajes cargados no dispara el loop de getSnapshot', async () => {
    const cleanup = await render(
      React.createElement(Thread, { conversationId: 'c1', onBack: () => undefined }),
    );
    expect(errors.filter((e) => e.includes('getSnapshot'))).toEqual([]);
    expect(errors.filter((e) => e.includes('Maximum update depth'))).toEqual([]);
    cleanup();
  });

  it('re-render por cambio de estado ajeno tampoco (getSnapshot estable entre evaluaciones)', async () => {
    const cleanup = await render(
      React.createElement(Thread, { conversationId: 'c1', onBack: () => undefined }),
    );
    await act(async () => {
      useInbox.setState({ connection: 'reconnecting' }); // cambio no relacionado
    });
    expect(sawSnapshotLoop()).toBe(false);
    cleanup();
  });
});
