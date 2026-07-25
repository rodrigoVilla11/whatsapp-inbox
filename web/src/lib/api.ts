import type {
  Conversation,
  Me,
  Message,
  QuickReply,
  SendResult,
  Template,
} from './types';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => json<Me>('/me'),

  listConversations: (filter: 'open' | 'all', assignedToMe: boolean, cursor?: string) => {
    const params = new URLSearchParams();
    if (filter === 'all') params.set('status', 'all');
    if (assignedToMe) params.set('assignedToMe', 'true');
    if (cursor) params.set('cursor', cursor);
    return json<{ conversations: Conversation[]; nextCursor: string | null; timezone: string }>(
      `/conversations?${params}`,
    );
  },

  listMessages: (conversationId: string, cursor?: string) =>
    json<{ messages: Message[]; nextCursor: string | null }>(
      `/conversations/${conversationId}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  markRead: (conversationId: string) =>
    json<{ conversation: Conversation }>(`/conversations/${conversationId}/read`, {
      method: 'POST',
    }),

  assign: (conversationId: string, userId: string | null) =>
    json<{ conversation: Conversation }>(`/conversations/${conversationId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  setStatus: (conversationId: string, status: 'OPEN' | 'CLOSED') =>
    json<{ conversation: Conversation }>(`/conversations/${conversationId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  listTemplates: () => json<Template[]>('/templates'),

  quickReplies: {
    list: (includeInactive = false) =>
      json<QuickReply[]>(`/quick-replies${includeInactive ? '?includeInactive=true' : ''}`),
    create: (input: { shortcut: string; title: string; body: string }) =>
      json<QuickReply>('/quick-replies', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: Partial<QuickReply>) =>
      json<QuickReply>(`/quick-replies/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deactivate: (id: string) => json<{ ok: true }>(`/quick-replies/${id}`, { method: 'DELETE' }),
  },

  /**
   * Envío: el envelope { message, error } llega con CUALQUIER status HTTP —
   * no se tira en 4xx/5xx (el caller decide por error.code). Un throw acá
   * es solo fallo de RED → el composer reintenta con la MISMA key.
   */
  sendMessage: async (
    conversationId: string,
    body:
      | { clientDedupKey: string; type: 'text'; body: string }
      | { clientDedupKey: string; type: 'template'; templateId: string; params: string[] },
  ): Promise<SendResult> => {
    const res = await fetch(`${API_URL}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const envelope = (await res.json().catch(() => ({ message: null, error: null }))) as Omit<
      SendResult,
      'httpStatus'
    >;
    return { ...envelope, httpStatus: res.status };
  },

  /** Multipart con barra de progreso (XHR: fetch no reporta progreso de subida). */
  sendMedia: (
    conversationId: string,
    input: { clientDedupKey: string; file: File; caption?: string },
    onProgress: (percent: number) => void,
  ): Promise<SendResult> =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', input.file, input.file.name);
      form.append('clientDedupKey', input.clientDedupKey);
      if (input.caption) form.append('caption', input.caption);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/conversations/${conversationId}/media`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const envelope = JSON.parse(xhr.responseText) as Omit<SendResult, 'httpStatus'>;
          resolve({ ...envelope, httpStatus: xhr.status });
        } catch {
          resolve({ message: null, error: null, httpStatus: xhr.status });
        }
      };
      xhr.onerror = () => reject(new Error('network')); // red → misma key
      xhr.send(form);
    }),

  mediaUrl: (messageId: string) => `${API_URL}/messages/${messageId}/media`,
};
