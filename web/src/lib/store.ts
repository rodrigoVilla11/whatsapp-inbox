'use client';

import { create } from 'zustand';
import { api } from './api';
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
import type {
  Conversation,
  ConversationUpdatedEvent,
  Me,
  Message,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  QuickReply,
  SendResult,
  Template,
} from './types';

export type ListFilter = 'open' | 'all' | 'mine';

interface InboxState {
  me: Me | null;
  timezone: string;
  connection: 'online' | 'reconnecting';
  filter: ListFilter;
  conversations: Conversation[];
  nextCursor: string | null;
  selectedId: string | null;
  /** Mensajes por conversación, ascendentes por timestamp. */
  messages: Record<string, Message[]>;
  messagesCursor: Record<string, string | null>;
  templates: Template[];
  quickReplies: QuickReply[];
  /** Estado de envío por mensaje local/real (key = clientDedupKey). */
  outbox: Record<string, OutboxEntry>;
  uploadProgress: Record<string, number>;
  lastError: string | null;

  bootstrap(): Promise<void>;
  setFilter(filter: ListFilter): Promise<void>;
  loadConversations(): Promise<void>;
  loadMoreConversations(): Promise<void>;
  select(conversationId: string | null): Promise<void>;
  loadOlderMessages(conversationId: string): Promise<void>;
  refetchAfterReconnect(): Promise<void>;
  setConnection(state: 'online' | 'reconnecting'): void;

  onMessageCreated(event: MessageCreatedEvent): void;
  onMessageUpdated(event: MessageUpdatedEvent): void;
  onConversationUpdated(event: ConversationUpdatedEvent): void;

  sendText(conversationId: string, body: string): Promise<void>;
  sendTemplate(conversationId: string, templateId: string, params: string[], preview: string): Promise<void>;
  sendMedia(conversationId: string, file: File, caption: string | null): Promise<void>;
  retrySend(message: Message): Promise<void>;

  markRead(conversationId: string): Promise<void>;
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
    nextCursor: null,
    selectedId: null,
    messages: {},
    messagesCursor: {},
    templates: [],
    quickReplies: [],
    outbox: {},
    uploadProgress: {},
    lastError: null,

    async bootstrap() {
      const [me, templates, quickReplies] = await Promise.all([
        api.me(),
        api.listTemplates().catch(() => []),
        api.quickReplies.list().catch(() => []),
      ]);
      set({ me, timezone: me.timezone, templates, quickReplies });
      await get().loadConversations();
    },

    async setFilter(filter) {
      set({ filter });
      await get().loadConversations();
    },

    async loadConversations() {
      const { filter, me } = get();
      const result = await api.listConversations(
        filter === 'all' ? 'all' : 'open',
        filter === 'mine' && !!me?.userId,
      );
      set({
        conversations: result.conversations,
        nextCursor: result.nextCursor,
        timezone: result.timezone,
      });
    },

    async loadMoreConversations() {
      const { filter, me, nextCursor, conversations } = get();
      if (!nextCursor) return;
      const result = await api.listConversations(
        filter === 'all' ? 'all' : 'open',
        filter === 'mine' && !!me?.userId,
        nextCursor,
      );
      set({
        conversations: [...conversations, ...result.conversations],
        nextCursor: result.nextCursor,
      });
    },

    async select(conversationId) {
      set({ selectedId: conversationId });
      if (!conversationId) return;
      const page = await api.listMessages(conversationId);
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: sortMessages([...page.messages].reverse()),
        },
        messagesCursor: { ...s.messagesCursor, [conversationId]: page.nextCursor },
      }));
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (conversation && conversation.unreadCount > 0) {
        await get().markRead(conversationId);
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
      await get().loadConversations();
      const selected = get().selectedId;
      if (selected) {
        const page = await api.listMessages(selected);
        set((s) => ({
          messages: { ...s.messages, [selected]: sortMessages([...page.messages].reverse()) },
          messagesCursor: { ...s.messagesCursor, [selected]: page.nextCursor },
        }));
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

    onConversationUpdated({ conversation }) {
      set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
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

    async assign(conversationId, userId) {
      const { conversation } = await api.assign(conversationId, userId);
      set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
    },

    async setConversationStatus(conversationId, status) {
      const { conversation } = await api.setStatus(conversationId, status);
      set((s) => ({ conversations: upsertConversation(s.conversations, conversation) }));
    },

    dismissError() {
      set({ lastError: null });
    },
  };
});
