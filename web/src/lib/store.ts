'use client';

/**
 * REGLA PERMANENTE — selectores de este store (y de cualquier otro):
 * deben devolver REFERENCIAS ESTABLES. Nada de literales, spreads,
 * map/filter/slice/sort ni `?? []` / `?? {}` dentro del selector — React
 * compara el resultado de getSnapshot por referencia y un valor nuevo por
 * evaluación produce un loop infinito de re-renders.
 *
 * Remedios, en orden de preferencia:
 * 1. Seleccionar el dato crudo y derivar en el componente con useMemo.
 * 2. Fallbacks vacíos como constante módulo-level (lib/selectors.ts).
 * 3. useShallow (zustand/react/shallow) para selecciones múltiples {a,b,c}.
 */
import { create } from 'zustand';
import { api, isUnauthorized } from './api';
import {
  manualRetry,
  nextNetworkAttempt,
  onDomainFailure,
  onNetworkError,
  type OutboxEntry,
  shouldAutoRetry,
  startSend,
} from './composer';
import { applyMessageChanges, sortMessages, upsertConversation, upsertMessage } from './merge';
import { isActiveOrderKind, mergeOrder, type OrdersBundle } from './order-ui';
import { createDebounce, SEARCH_DEBOUNCE_MS } from './search';
import type {
  AgentUser,
  Conversation,
  ConversationUpdatedEvent,
  Me,
  Message,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  OrderUpdatedEvent,
  QuickReply,
  SendResult,
  Template,
} from './types';

export type ListFilter = 'open' | 'all' | 'mine' | 'closed';

/** ¿La conversación pertenece a la lista visible según el tab? (solo status —
 * el resto del filtrado es del server; esto evita que un conversation.updated
 * re-inserte una cerrada en "Abiertas"). */
function statusMatchesFilter(status: Conversation['status'], filter: ListFilter): boolean {
  if (filter === 'closed') return status === 'CLOSED';
  if (filter === 'all') return true;
  return status !== 'CLOSED'; // open y mine
}

interface InboxState {
  me: Me | null;
  timezone: string;
  connection: 'online' | 'reconnecting';
  filter: ListFilter;
  conversations: Conversation[];
  /** Agentes del tenant (GET /users) — selector de asignación y chips. */
  users: AgentUser[];
  /** Texto del input de búsqueda (inmediato; el fetch va con debounce). */
  searchQuery: string;
  conversationsLoading: boolean;
  nextCursor: string | null;
  selectedId: string | null;
  /** Mensajes por conversación, ascendentes por timestamp. */
  messages: Record<string, Message[]>;
  messagesCursor: Record<string, string | null>;
  /** Pedidos de Gourmetify por CONTACTO (activos + últimos cerrados). */
  orders: Record<string, OrdersBundle>;
  templates: Template[];
  quickReplies: QuickReply[];
  /** Estado de envío por mensaje local/real (key = clientDedupKey). */
  outbox: Record<string, OutboxEntry>;
  uploadProgress: Record<string, number>;
  lastError: string | null;

  bootstrap(): Promise<void>;
  setFilter(filter: ListFilter): Promise<void>;
  setSearchQuery(q: string): void;
  saveContactNotes(conversationId: string, notes: string): Promise<void>;
  loadConversations(): Promise<void>;
  loadMoreConversations(): Promise<void>;
  select(conversationId: string | null): Promise<void>;
  loadOlderMessages(conversationId: string): Promise<void>;
  refetchAfterReconnect(): Promise<void>;
  setConnection(state: 'online' | 'reconnecting'): void;

  onMessageCreated(event: MessageCreatedEvent): void;
  onMessageUpdated(event: MessageUpdatedEvent): void;
  onConversationUpdated(event: ConversationUpdatedEvent): void;
  onOrderUpdated(event: OrderUpdatedEvent): void;
  loadOrders(conversationId: string): Promise<void>;

  sendText(conversationId: string, body: string): Promise<void>;
  sendTemplate(conversationId: string, templateId: string, params: string[], preview: string): Promise<void>;
  sendMedia(conversationId: string, file: File, caption: string | null): Promise<void>;
  retrySend(message: Message): Promise<void>;

  markRead(conversationId: string): Promise<void>;
  markUnread(conversationId: string): Promise<void>;
  assign(conversationId: string, userId: string | null): Promise<void>;
  setConversationStatus(conversationId: string, status: 'OPEN' | 'CLOSED'): Promise<void>;
  dismissError(): void;
}

function optimisticMessage(
  conversationId: string,
  key: string,
  fields: Partial<Message>,
): Message {
  const now = new Date().toISOString();
  return {
    id: `local-${key}`,
    conversationId,
    wamid: null,
    clientDedupKey: key,
    direction: 'OUTBOUND',
    type: 'TEXT',
    status: 'PENDING',
    body: null,
    replyToWamid: null,
    templateName: null,
    templateLanguage: null,
    mediaMimeType: null,
    mediaFilename: null,
    mediaSizeBytes: null,
    mediaStatus: null,
    transcription: null,
    isAutoReply: false,
    errorCode: null,
    errorTitle: null,
    errorDetail: null,
    sentByUserId: null,
    timestamp: now,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    createdAt: now,
    _local: 'sending',
    ...fields,
  };
}

export const useInbox = create<InboxState>()((set, get) => {
  // Guardia de carrera: dos fetches de lista en vuelo (tipeo rápido en la
  // búsqueda) — solo el más reciente escribe el estado.
  let listRequestSeq = 0;
  const searchDebounce = createDebounce(() => void get().loadConversations(), SEARCH_DEBOUNCE_MS);

  function putMessage(conversationId: string, message: Message): void {
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: upsertMessage(s.messages[conversationId] ?? [], message),
      },
    }));
  }

  /** Resultado del POST de envío → estado. Devuelve true si hubo respuesta del server. */
  function applySendResult(conversationId: string, key: string, result: SendResult): void {
    if (result.message) putMessage(conversationId, result.message);
    set((s) => ({
      outbox: {
        ...s.outbox,
        [key]:
          result.error && result.message?.status === 'FAILED'
            ? onDomainFailure(s.outbox[key] ?? startSend(() => key))
            : { clientDedupKey: key, attempts: 1, status: 'sending' },
      },
      lastError: result.error ? result.error.message : s.lastError,
    }));
    if (!result.error) {
      set((s) => {
        const outbox = { ...s.outbox };
        delete outbox[key];
        return { outbox };
      });
    }
  }

  /** Envío con el contrato de red: 1 auto-retry con la MISMA key. */
  async function runSend(
    conversationId: string,
    key: string,
    doSend: () => Promise<SendResult>,
  ): Promise<void> {
    let entry = get().outbox[key] ?? { clientDedupKey: key, attempts: 1, status: 'sending' as const };
    set((s) => ({ outbox: { ...s.outbox, [key]: entry } }));
    for (;;) {
      try {
        const result = await doSend();
        applySendResult(conversationId, key, result);
        return;
      } catch {
        entry = onNetworkError(entry);
        if (shouldAutoRetry(entry)) {
          entry = nextNetworkAttempt(entry);
          set((s) => ({ outbox: { ...s.outbox, [key]: entry } }));
          continue; // MISMA key
        }
        set((s) => ({
          outbox: { ...s.outbox, [key]: entry },
          messages: {
            ...s.messages,
            [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
              m.clientDedupKey === key ? { ...m, status: 'FAILED', _local: 'failed-network' } : m,
            ),
          },
        }));
        return;
      }
    }
  }

  return {
    me: null,
    timezone: 'UTC',
    connection: 'reconnecting',
    filter: 'open',
    conversations: [],
    users: [],
    searchQuery: '',
    conversationsLoading: true,
    nextCursor: null,
    selectedId: null,
    messages: {},
    messagesCursor: {},
    orders: {},
    templates: [],
    quickReplies: [],
    outbox: {},
    uploadProgress: {},
    lastError: null,

    async bootstrap() {
      // /auth/me primero: es el gate. 401 → redirect a /login ya disparado
      // por api.ts; acá se corta en silencio (nada de fondo sin sesión).
      let me;
      try {
        me = await api.me();
      } catch (error) {
        if (isUnauthorized(error)) return;
        set({
          conversationsLoading: false,
          lastError: 'No pudimos conectar con el servidor — revisá que la API esté corriendo.',
        });
        return;
      }
      const [templates, quickReplies, users] = await Promise.all([
        api.listTemplates().catch(() => []),
        api.quickReplies.list().catch(() => []),
        api.listUsers().catch(() => []),
      ]);
      set({ me, timezone: me.timezone, templates, quickReplies, users });
      await get().loadConversations();
    },

    async setFilter(filter) {
      // cambiar de tab sale del modo búsqueda: el tab vuelve a mandar
      searchDebounce.cancel();
      set({ filter, searchQuery: '' });
      await get().loadConversations();
    },

    setSearchQuery(q) {
      set({ searchQuery: q });
      searchDebounce.call();
    },

    async saveContactNotes(conversationId, notes) {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      const contactId = conversation?.contact?.id;
      if (!contactId) return;
      const { contact } = await api.updateContactNotes(contactId, notes);
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.contact?.id === contact.id ? { ...c, contact } : c,
        ),
      }));
    },

    async loadConversations() {
      const { filter, me, searchQuery } = get();
      const seq = ++listRequestSeq;
      set({ conversationsLoading: true });
      try {
        const result = await api.listConversations({
          filter: filter === 'all' || filter === 'closed' ? filter : 'open',
          assignedToMe: filter === 'mine' && !!me?.userId,
          q: searchQuery,
        });
        if (seq !== listRequestSeq) return; // llegó tarde: hay un fetch más nuevo
        set({
          conversations: result.conversations,
          nextCursor: result.nextCursor,
          timezone: result.timezone,
          conversationsLoading: false,
        });
      } catch (error) {
        if (seq !== listRequestSeq) return;
        if (isUnauthorized(error)) {
          // fondo sin sesión: el redirect al login ya corre — cero overlay
          set({ conversationsLoading: false });
          return;
        }
        // el error ya se comunica por lastError; acá no hay retry a ciegas
        set({
          conversationsLoading: false,
          lastError: 'No pudimos cargar las conversaciones — revisá la conexión y reintentá.',
        });
      }
    },

    async loadMoreConversations() {
      const { filter, me, nextCursor, conversations, searchQuery } = get();
      if (!nextCursor) return;
      try {
        const result = await api.listConversations({
          filter: filter === 'all' || filter === 'closed' ? filter : 'open',
          assignedToMe: filter === 'mine' && !!me?.userId,
          cursor: nextCursor,
          q: searchQuery,
        });
        set({
          conversations: [...conversations, ...result.conversations],
          nextCursor: result.nextCursor,
        });
      } catch (error) {
        if (isUnauthorized(error)) return; // redirect en curso
        set({ lastError: 'No pudimos cargar más conversaciones — reintentá.' });
      }
    },

    async select(conversationId) {
      set({ selectedId: conversationId });
      if (!conversationId) return;
      try {
        const page = await api.listMessages(conversationId);
        set((s) => ({
          messages: {
            ...s.messages,
            [conversationId]: sortMessages([...page.messages].reverse()),
          },
          messagesCursor: { ...s.messagesCursor, [conversationId]: page.nextCursor },
        }));
        // Pedidos del contacto: en paralelo, sin bloquear el hilo.
        void get().loadOrders(conversationId);
        const conversation = get().conversations.find((c) => c.id === conversationId);
        if (conversation && conversation.unreadCount > 0) {
          await get().markRead(conversationId);
        }
      } catch (error) {
        if (isUnauthorized(error)) return; // redirect en curso
        set({ lastError: 'No pudimos abrir la conversación — reintentá.' });
      }
    },

    /** Pedidos de Gourmetify del contacto — feature opcional: falla en silencio. */
    async loadOrders(conversationId) {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      const contactId = conversation?.contact?.id;
      if (!contactId) return;
      try {
        const bundle = await api.listOrders(conversationId);
        set((s) => ({ orders: { ...s.orders, [contactId]: bundle } }));
      } catch {
        // sin integración de pedidos (o error transitorio): el panel no aparece
      }
    },

    async loadOlderMessages(conversationId) {
      const cursor = get().messagesCursor[conversationId];
      if (!cursor) return;
      const page = await api.listMessages(conversationId, cursor);
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: sortMessages([
            ...page.messages,
            ...(s.messages[conversationId] ?? []),
          ]),
        },
        messagesCursor: { ...s.messagesCursor, [conversationId]: page.nextCursor },
      }));
    },

    /** Contrato de reconexión: refetch REST y recién después confiar en el stream. */
    async refetchAfterReconnect() {
      // Gate de auth: actividad de FONDO jamás corre sin sesión resuelta
      // (post-logout o pre-bootstrap este método es un no-op, no un 401).
      if (!get().me) return;
      try {
        await get().loadConversations();
        const selected = get().selectedId;
        if (selected) {
          const page = await api.listMessages(selected);
          set((s) => ({
            messages: { ...s.messages, [selected]: sortMessages([...page.messages].reverse()) },
            messagesCursor: { ...s.messagesCursor, [selected]: page.nextCursor },
          }));
          void get().loadOrders(selected); // pedidos también, sin bloquear
        }
      } catch (error) {
        if (isUnauthorized(error)) return; // redirect en curso, silencio
        set({ lastError: 'No pudimos actualizar al reconectar — recargá si algo se ve viejo.' });
      }
    },

    setConnection(state) {
      set({ connection: state });
    },

    onMessageCreated({ conversationId, message }) {
      // Dedup por id/clientDedupKey contra el POST propio: merge, no duplicado.
      if (get().messages[conversationId]) putMessage(conversationId, message);
    },

    onMessageUpdated({ id, conversationId, changes }) {
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: applyMessageChanges(s.messages[conversationId] ?? [], id, changes),
        },
      }));
    },

    onOrderUpdated({ order, contactId }) {
      // Sin contacto linkeado todavía no hay dónde colgarlo; aparece en el
      // próximo loadOrders (que además backfillea el link server-side).
      if (!contactId) return;
      set((s) => ({
        orders: { ...s.orders, [contactId]: mergeOrder(s.orders[contactId], order) },
        // Un pedido activo ENCIENDE el resaltado de la fila en vivo (el
        // apagado exacto llega con el próximo listado — un solo evento no
        // alcanza para saber si quedan otros activos).
        conversations: isActiveOrderKind(order.statusKind)
          ? s.conversations.map((c) =>
              c.contactId === contactId && !c.hasActiveOrder
                ? { ...c, hasActiveOrder: true }
                : c,
            )
          : s.conversations,
      }));
    },

    onConversationUpdated({ conversation }) {
      set((s) => {
        // Buscando se ven todos los estados; si no, el evento respeta el tab
        // (que un cierre ajeno no re-inserte la fila en "Abiertas").
        if (!s.searchQuery && !statusMatchesFilter(conversation.status, s.filter)) {
          if (!s.conversations.some((c) => c.id === conversation.id)) return s;
          return { conversations: s.conversations.filter((c) => c.id !== conversation.id) };
        }
        return { conversations: upsertConversation(s.conversations, conversation) };
      });
    },

    async sendText(conversationId, body) {
      const entry = startSend();
      putMessage(conversationId, optimisticMessage(conversationId, entry.clientDedupKey, { body }));
      await runSend(conversationId, entry.clientDedupKey, () =>
        api.sendMessage(conversationId, {
          clientDedupKey: entry.clientDedupKey,
          type: 'text',
          body,
        }),
      );
    },

    async sendTemplate(conversationId, templateId, params, preview) {
      const entry = startSend();
      putMessage(
        conversationId,
        optimisticMessage(conversationId, entry.clientDedupKey, { type: 'TEMPLATE', body: preview }),
      );
      await runSend(conversationId, entry.clientDedupKey, () =>
        api.sendMessage(conversationId, {
          clientDedupKey: entry.clientDedupKey,
          type: 'template',
          templateId,
          params,
        }),
      );
    },

    async sendMedia(conversationId, file, caption) {
      const entry = startSend();
      const kind = file.type.startsWith('image/')
        ? 'IMAGE'
        : file.type.startsWith('video/')
          ? 'VIDEO'
          : file.type.startsWith('audio/')
            ? 'AUDIO'
            : 'DOCUMENT';
      putMessage(
        conversationId,
        optimisticMessage(conversationId, entry.clientDedupKey, {
          type: kind,
          body: caption,
          mediaFilename: file.name,
          mediaSizeBytes: file.size,
          mediaMimeType: file.type,
          mediaStatus: 'PENDING',
        }),
      );
      await runSend(conversationId, entry.clientDedupKey, () =>
        api.sendMedia(
          conversationId,
          { clientDedupKey: entry.clientDedupKey, file, caption: caption ?? undefined },
          (percent) =>
            set((s) => ({
              uploadProgress: { ...s.uploadProgress, [entry.clientDedupKey]: percent },
            })),
        ),
      );
      set((s) => {
        const uploadProgress = { ...s.uploadProgress };
        delete uploadProgress[entry.clientDedupKey];
        return { uploadProgress };
      });
    },

    /** Botón reintentar: red → misma key; FAILED de dominio → key NUEVA. */
    async retrySend(message) {
      const key = message.clientDedupKey;
      if (!key) return;
      const current =
        get().outbox[key] ??
        ({ clientDedupKey: key, attempts: 1, status: 'failed-domain' } as OutboxEntry);
      const next = manualRetry(current);

      if (next.clientDedupKey === key) {
        // mismo envío (red): reusar el POST
        await runSend(message.conversationId, key, () =>
          api.sendMessage(message.conversationId, {
            clientDedupKey: key,
            type: 'text',
            body: message.body ?? '',
          }),
        );
        return;
      }
      // envío nuevo por decisión humana (solo texto: media/template se re-eligen)
      if (message.body) {
        await get().sendText(message.conversationId, message.body);
      }
    },

    async markRead(conversationId) {
      const { conversation } = await api.markRead(conversationId);
      set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
    },

    async markUnread(conversationId) {
      const { conversation } = await api.markUnread(conversationId);
      set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
    },

    async assign(conversationId, userId) {
      const { conversation } = await api.assign(conversationId, userId);
      set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
    },

    async setConversationStatus(conversationId, status) {
      const { conversation } = await api.setStatus(conversationId, status);
      set((s) => ({
        conversations:
          !s.searchQuery && !statusMatchesFilter(conversation.status, s.filter)
            ? s.conversations.filter((c) => c.id !== conversation.id) // sale del tab
            : upsertConversation(s.conversations, conversation),
      }));
    },

    dismissError() {
      set({ lastError: null });
    },
  };
});
