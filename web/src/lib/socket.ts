'use client';

import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';
import { useInbox } from './store';

let socket: Socket | null = null;

/**
 * Conexión única al namespace /inbox. Contrato de reconexión (fase 6):
 * al reconectar → refetch REST de lista + hilo abierto, y recién después
 * confiar en el stream. Mientras está caído: indicador "reconectando".
 */
export function connectInboxSocket(): () => void {
  if (socket) return () => undefined;

  const s = io(`${API_URL}/inbox`, { transports: ['websocket'] });
  socket = s;
  const store = useInbox.getState;

  s.on('connect', () => {
    useInbox.setState({ connection: 'online' });
    void store().refetchAfterReconnect();
  });
  s.on('disconnect', () => useInbox.setState({ connection: 'reconnecting' }));
  s.io.on('reconnect_attempt', () => useInbox.setState({ connection: 'reconnecting' }));

  s.on('message.created', (payload) => store().onMessageCreated(payload));
  s.on('message.updated', (payload) => store().onMessageUpdated(payload));
  s.on('conversation.updated', (payload) => store().onConversationUpdated(payload));

  return () => {
    s.disconnect();
    socket = null;
  };
}
