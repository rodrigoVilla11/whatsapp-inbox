import { describe, expect, it } from 'vitest';
import {
  applyMessageChanges,
  upsertConversation,
  upsertMessage,
} from '../src/lib/merge';
import type { Conversation, Message } from '../src/lib/types';

const msg = (over: Partial<Message>): Message => ({
  id: 'm1',
  conversationId: 'c1',
  wamid: null,
  clientDedupKey: null,
  direction: 'OUTBOUND',
  type: 'TEXT',
  status: 'PENDING',
  body: 'hola',
  replyToWamid: null,
  templateName: null,
  templateLanguage: null,
  mediaMimeType: null,
  mediaFilename: null,
  mediaSizeBytes: null,
  mediaStatus: null,
  errorCode: null,
  errorTitle: null,
  errorDetail: null,
  sentByUserId: null,
  timestamp: '2026-07-25T12:00:00.000Z',
  deliveredAt: null,
  readAt: null,
  failedAt: null,
  createdAt: '2026-07-25T12:00:00.000Z',
  ...over,
});

const conv = (over: Partial<Conversation>): Conversation => ({
  id: 'c1',
  contactId: 'ct1',
  whatsappAccountId: 'a1',
  status: 'OPEN',
  assignedUserId: null,
  unreadCount: 0,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastMessageAt: '2026-07-25T12:00:00.000Z',
  lastMessagePreview: null,
  createdAt: '2026-07-25T10:00:00.000Z',
  isWindowOpen: true,
  windowExpiresAt: null,
  contact: { id: 'ct1', waId: '549', phoneE164: null, profileName: 'Juan', notes: null, isBlocked: false },
  ...over,
});

describe('upsertMessage (message.created + POST propio)', () => {
  it('inserta ordenado por timestamp asc', () => {
    const list = [msg({ id: 'a', timestamp: '2026-07-25T12:00:02.000Z' })];
    const result = upsertMessage(list, msg({ id: 'b', timestamp: '2026-07-25T12:00:01.000Z' }));
    expect(result.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('DEDUP por id: el evento WS del mensaje que ya llegó por REST mergea, no duplica', () => {
    const list = [msg({ id: 'real-1', status: 'PENDING' })];
    const result = upsertMessage(list, msg({ id: 'real-1', status: 'SENT', wamid: 'wamid.X' }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: 'SENT', wamid: 'wamid.X' });
  });

  it('DEDUP por clientDedupKey: la copia del server reemplaza al optimista local', () => {
    const list = [
      msg({ id: 'local-k1', clientDedupKey: 'k1', _local: 'sending' }),
      msg({ id: 'otro', timestamp: '2026-07-25T11:00:00.000Z' }),
    ];
    const server = msg({ id: 'real-99', clientDedupKey: 'k1', status: 'PENDING', wamid: 'w' });
    const result = upsertMessage(list, server);

    expect(result).toHaveLength(2); // sin duplicado
    const replaced = result.find((m) => m.clientDedupKey === 'k1')!;
    expect(replaced.id).toBe('real-99'); // gana el id real
    expect(replaced._local).toBeUndefined(); // flag local limpiado
  });

  it('la carrera POST-propio vs WS del mismo mensaje converge a UNA copia', () => {
    let list: Message[] = [msg({ id: 'local-k2', clientDedupKey: 'k2', _local: 'sending' })];
    const serverCopy = msg({ id: 'real-5', clientDedupKey: 'k2' });
    list = upsertMessage(list, serverCopy); // llega el WS primero
    list = upsertMessage(list, serverCopy); // después la respuesta del POST
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('real-5');
  });
});

describe('applyMessageChanges (message.updated)', () => {
  it('mergea solo los campos de changes', () => {
    const list = [msg({ id: 'm1', status: 'SENT', body: 'texto' })];
    const result = applyMessageChanges(list, 'm1', {
      status: 'READ',
      readAt: '2026-07-25T12:05:00.000Z',
    });
    expect(result[0]).toMatchObject({ status: 'READ', body: 'texto' });
  });

  it('id desconocido → lista intacta (el mensaje no está cargado)', () => {
    const list = [msg({ id: 'm1' })];
    expect(applyMessageChanges(list, 'fantasma', { status: 'READ' })).toBe(list);
  });
});

describe('upsertConversation (conversation.updated)', () => {
  it('REEMPLAZA la fila y reordena por lastMessageAt desc', () => {
    const list = [
      conv({ id: 'c1', lastMessageAt: '2026-07-25T12:00:00.000Z' }),
      conv({ id: 'c2', lastMessageAt: '2026-07-25T11:00:00.000Z' }),
    ];
    const result = upsertConversation(
      list,
      conv({ id: 'c2', lastMessageAt: '2026-07-25T13:00:00.000Z', unreadCount: 3, contact: undefined }),
    );
    expect(result.map((c) => c.id)).toEqual(['c2', 'c1']); // subió
    expect(result[0].unreadCount).toBe(3);
  });

  it('preserva el contact embebido que el evento WS no trae', () => {
    const list = [conv({ id: 'c1' })];
    const result = upsertConversation(list, conv({ id: 'c1', unreadCount: 1, contact: undefined }));
    expect(result[0].contact?.profileName).toBe('Juan');
  });

  it('inserta conversaciones nuevas (primer mensaje de un cliente)', () => {
    const result = upsertConversation([], conv({ id: 'c_nueva', contact: undefined }));
    expect(result).toHaveLength(1);
    expect(result[0].contact).toBeNull();
  });
});
