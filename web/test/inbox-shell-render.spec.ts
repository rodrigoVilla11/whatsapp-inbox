// @vitest-environment jsdom
/**
 * Render del árbol COMPLETO (InboxShell → lista + hilo + panel) bajo
 * StrictMode, con next/navigation, socket y fetch mockeados: cubre el
 * camino real del bug reportado (click en conversación) de punta a punta,
 * salvo la hidratación SSR que solo existe en el browser.
 */
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'c1' }),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

// io como spy: los tests de auth verifican CUÁNDO se instancia la conexión.
const { ioMock } = vi.hoisted(() => ({
  ioMock: vi.fn(() => ({
    on: () => undefined,
    disconnect: () => undefined,
    io: { on: () => undefined },
  })),
}));
vi.mock('socket.io-client', () => ({ io: ioMock }));

import { InboxShell } from '../src/components/InboxShell';
import { authRedirect } from '../src/lib/api';
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
  createdAt: new Date().toISOString(),
  isWindowOpen: true,
  windowExpiresAt: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
  contact: { id: 'ct1', waId: '549341', phoneE164: '+549341', profileName: 'Juan', notes: null, isBlocked: false },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let errors: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;
let redirectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = [];
  ioMock.mockClear();
  redirectSpy = vi.spyOn(authRedirect, 'trigger').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://test').pathname;
      if (path === '/api/auth/me') {
        // contrato fase 8: user + tenant desde la sesión
        return jsonResponse({
          user: { id: 'u1', email: 'u1@nova.test', name: 'Uno', role: 'OWNER', mustChangePassword: false },
          tenant: { id: 't1', slug: 'nova', name: 'Nova', timezone: 'UTC' },
        });
      }
      if (path.endsWith('/messages')) return jsonResponse({ messages: [], nextCursor: null });
      if (path === '/api/conversations') {
        return jsonResponse({ conversations: [conversationFixture], nextCursor: null, timezone: 'UTC' });
      }
      return jsonResponse([]); // templates, quick-replies, users
    }),
  );
  useInbox.setState({
    conversations: [],
    messages: {},
    messagesCursor: {},
    selectedId: null,
    timezone: 'UTC',
    me: null,
  });
});

afterEach(() => {
  errorSpy.mockRestore();
  redirectSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('InboxShell completo (click en conversación)', () => {
  it('monta lista + hilo + panel sin loop de getSnapshot, incluso tras cargar datos', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(StrictMode, null, React.createElement(InboxShell)));
    });
    // dejar asentar bootstrap + select (fetches mockeados → setState en cadena)
    await act(async () => {
      await Promise.resolve();
    });

    expect(errors.filter((e) => e.includes('getSnapshot'))).toEqual([]);
    expect(errors.filter((e) => e.includes('Maximum update depth'))).toEqual([]);
    // sanity: el hilo se abrió de verdad (selectedId tomado de la ruta)
    expect(useInbox.getState().selectedId).toBe('c1');
    // el socket SÍ se instanció — recién con la sesión resuelta
    expect(ioMock).toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it('con /auth/me en 401 el socket NO se instancia nunca (ni un handshake sin cookie)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://test').pathname;
        if (path === '/api/auth/me') {
          return new Response(JSON.stringify({ message: 'no' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse([]);
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(StrictMode, null, React.createElement(InboxShell)));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(ioMock).not.toHaveBeenCalled(); // el gate de auth manda
    expect(redirectSpy).toHaveBeenCalled(); // y el flujo de login está en curso
    expect(errors.filter((e) => e.includes('Maximum update depth'))).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });
});
