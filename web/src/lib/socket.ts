'use client';

import { io, type Socket } from 'socket.io-client';
import { API_ORIGIN, BASE_PATH } from './api';
import { notifyInbound } from './notify';
import { useInbox } from './store';
import type { MessageCreatedEvent } from './types';

let socket: Socket | null = null;
let refs = 0;

/**
 * Conexión única al namespace /inbox, PEREZOSA y estrictamente post-auth:
 * - Gate: si `me` no está resuelto en el store, esto es un no-op — jamás
 *   sale un handshake sin cookie (el log de diagnóstico del gateway debe
 *   quedar en silencio en una carga normal, StrictMode incluido).
 * - Refcount: N montajes comparten un socket; el último release desconecta.
 *   Cada cleanup es idempotente (StrictMode lo invoca de más sin romper).
 * - Logout: navegación full-page a /login → unmount → release → disconnect.
 *
 * Contrato de reconexión (fase 6): al reconectar → refetch REST (que a su
 * vez tiene su propio gate de auth) y recién después confiar en el stream.
 */
export function connectInboxSocket(): () => void {
  if (!useInbox.getState().me) return () => undefined; // sin sesión no hay socket

  refs += 1;
  if (!socket) {
    // withCredentials: la cookie de sesión autentica el handshake (fase 8).
    // Path /inbox/api/socket.io SIEMPRE (dev directo y prod vía proxy): es
    // el path literal del gateway — sin rewrites de por medio.
    const s = io(`${API_ORIGIN}/inbox`, {
      path: `${BASE_PATH}/api/socket.io`,
      transports: ['websocket'],
      withCredentials: true,
    });
    socket = s;
    const store = useInbox.getState;

    s.on('connect', () => {
      useInbox.setState({ connection: 'online' });
      void store().refetchAfterReconnect();
    });
    s.on('disconnect', () => useInbox.setState({ connection: 'reconnecting' }));
    s.io.on('reconnect_attempt', () => useInbox.setState({ connection: 'reconnecting' }));

    s.on('message.created', (payload: MessageCreatedEvent) => {
      store().onMessageCreated(payload);
      // sonido + notificación nativa: solo entrantes, según preferencias
      if (payload.message?.direction === 'INBOUND') notifyInbound(payload);
    });
    s.on('message.updated', (payload) => store().onMessageUpdated(payload));
    s.on('conversation.updated', (payload) => store().onConversationUpdated(payload));
  }

  let released = false;
  return () => {
    if (released) return; // cleanup idempotente
    released = true;
    refs -= 1;
    if (refs <= 0 && socket) {
      socket.disconnect();
      socket = null;
      refs = 0;
    }
  };
}
