/**
 * Fase 8.1: la actividad de fondo se subordina al estado de auth.
 * - bootstrap habla con /auth/me (la ruta vieja /me murió).
 * - refetchAfterReconnect sin sesión resuelta = no-op (cero fetch).
 * - un 401 de fondo dispara el flujo de logout SIN unhandled rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedirect } from '../src/lib/api';
import { useInbox } from '../src/lib/store';
import type { Me } from '../src/lib/types';

const ME_RESPONSE = {
  user: { id: 'u1', email: 'u1@nova.test', name: 'Uno', role: 'OWNER', mustChangePassword: false },
  tenant: { id: 't1', slug: 'nova', name: 'Nova', timezone: 'UTC' },
};

const FAKE_ME: Me = {
  tenantId: 't1',
  userId: 'u1',
  tenantName: 'Nova',
  timezone: 'UTC',
  name: 'Uno',
  email: 'u1@nova.test',
  role: 'OWNER',
  mustChangePassword: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let requestedPaths: string[];
let redirectSpy: ReturnType<typeof vi.spyOn>;

/** Stub de fetch que registra pathnames y responde según un mapa. */
function stubFetch(respond: (path: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://test').pathname;
      requestedPaths.push(path);
      return respond(path);
    }),
  );
}

beforeEach(() => {
  requestedPaths = [];
  redirectSpy = vi.spyOn(authRedirect, 'trigger').mockImplementation(() => undefined);
  useInbox.setState({
    me: null,
    conversations: [],
    messages: {},
    messagesCursor: {},
    selectedId: null,
    searchQuery: '',
    conversationsLoading: true,
    lastError: null,
    users: [],
  });
});

afterEach(() => {
  redirectSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('bootstrap', () => {
  it('pide /auth/me — la ruta pre-fase-8 /me no se llama nunca', async () => {
    stubFetch((path) => {
      if (path === '/api/auth/me') return jsonResponse(ME_RESPONSE);
      if (path === '/api/conversations')
        return jsonResponse({ conversations: [], nextCursor: null, timezone: 'UTC' });
      return jsonResponse([]);
    });

    await useInbox.getState().bootstrap();

    expect(requestedPaths).toContain('/api/auth/me');
    expect(requestedPaths).not.toContain('/me'); // ruta pre-fase-8, muerta
    expect(useInbox.getState().me?.tenantName).toBe('Nova');
  });

  it('401 en /auth/me → corta en silencio: redirect disparado, nada más se fetchea', async () => {
    stubFetch((path) =>
      path === '/api/auth/me' ? jsonResponse({ message: 'no' }, 401) : jsonResponse([]),
    );

    await expect(useInbox.getState().bootstrap()).resolves.toBeUndefined(); // sin throw
    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(useInbox.getState().me).toBeNull();
    expect(requestedPaths).toEqual(['/api/auth/me']); // ni templates ni conversaciones
  });
});

describe('refetchAfterReconnect (actividad de fondo con gate de auth)', () => {
  it('sin me resuelto → no hace NINGÚN fetch', async () => {
    stubFetch(() => jsonResponse([]));
    await useInbox.getState().refetchAfterReconnect();
    expect(requestedPaths).toEqual([]);
  });

  it('con sesión caída (401) → redirect silencioso, sin rechazo y sin overlay de error', async () => {
    useInbox.setState({ me: FAKE_ME });
    stubFetch(() => jsonResponse({ message: 'no' }, 401));

    await expect(useInbox.getState().refetchAfterReconnect()).resolves.toBeUndefined();
    expect(redirectSpy).toHaveBeenCalled();
    expect(useInbox.getState().lastError).toBeNull(); // el 401 de fondo no grita
  });
});
