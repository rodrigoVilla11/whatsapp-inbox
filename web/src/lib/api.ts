import type {
  AgentUser,
  AuthUser,
  AutoReplyConfig,
  Contact,
  Conversation,
  GourmetifyOrder,
  ManagedUser,
  Me,
  Message,
  QuickReply,
  SendResult,
  Template,
} from './types';

/**
 * UN SOLO ORIGEN (fase 10b) + integración Gourmetify: en producción el
 * inbox vive bajo <dominio>/inbox y llama a la API con rutas RELATIVAS
 * /inbox/api/* (el proxy reescribe a /api/* del servicio API) — mismo
 * dominio, cero CORS, cookie sin Domain.
 * NEXT_PUBLIC_API_ORIGIN existe SOLO para dev (web :3000 → api :3001,
 * seteada en web/.env.development); en producción no se define.
 */
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';
/** Debe coincidir con basePath de next.config.ts. */
export const BASE_PATH = '/inbox';
const API_BASE = API_ORIGIN ? `${API_ORIGIN}/api` : `${BASE_PATH}/api`;

/**
 * TODAS las rutas de la API en un solo lugar: un rename futuro (como el
 * /me → /auth/me de la fase 8) se hace acá y en ningún otro archivo.
 */
export const API_ROUTES = {
  authLogin: '/auth/login',
  authLogout: '/auth/logout',
  authMe: '/auth/me',
  authChangePassword: '/auth/change-password',
  users: '/users',
  user: (id: string) => `/users/${id}`,
  conversations: '/conversations',
  conversationOpenByPhone: '/conversations/open-by-phone',
  conversationMessages: (id: string) => `/conversations/${id}/messages`,
  conversationOrders: (id: string) => `/conversations/${id}/orders`,
  conversationRead: (id: string) => `/conversations/${id}/read`,
  conversationUnread: (id: string) => `/conversations/${id}/unread`,
  conversationAssign: (id: string) => `/conversations/${id}/assign`,
  conversationStatus: (id: string) => `/conversations/${id}/status`,
  conversationMedia: (id: string) => `/conversations/${id}/media`,
  contact: (id: string) => `/contacts/${id}`,
  templates: '/templates',
  quickReplies: '/quick-replies',
  quickReply: (id: string) => `/quick-replies/${id}`,
  messageMedia: (id: string) => `/messages/${id}/media`,
  messageTranscribe: (id: string) => `/messages/${id}/transcribe`,
  autoReplySettings: '/settings/auto-reply',
} as const;

/**
 * 401 de un endpoint del dominio = la sesión no existe o venció. El error
 * es TIPADO para que los flujos de fondo (refetch de reconexión, búsqueda
 * debounced) lo traguen en silencio: el redirect ya está en curso y un
 * overlay de "unhandled rejection" no le sirve a nadie. Los /auth/* quedan
 * afuera: sus 401 son parte del flujo (password incorrecta).
 */
export class UnauthorizedError extends Error {
  constructor() {
    super('Necesitás iniciar sesión de nuevo');
    this.name = 'UnauthorizedError';
  }
}

export function isUnauthorized(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}

/**
 * Normaliza la respuesta de un envío al envelope { message, error }.
 *
 * Hace falta porque un throw de Nest (400 de validación, 413 de multer, 500
 * de un fallo de Graph/R2) contesta { statusCode, message: string, error:
 * string } — la MISMA forma que el envelope pero con tipos distintos. Sin
 * validar, ese `message` STRING entraba al store como si fuera un Message y
 * el render moría en formatTime (RangeError: Invalid time value) llevándose
 * la página entera. Acá: sólo un objeto es Message, y un cuerpo de excepción
 * se traduce a un error de dominio mostrable.
 */
export function parseSendEnvelope(raw: unknown, httpStatus: number): SendResult {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  // Sólo un objeto PLANO es un Message: un string es el texto de una
  // excepción y un array es el `message` del ValidationPipe de Nest.
  const isPlainObject = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const message = isPlainObject(body.message) ? (body.message as Message) : null;
  const error = isPlainObject(body.error) ? (body.error as SendResult['error']) : null;

  if (error || httpStatus < 400) return { message, error, httpStatus };

  // Cuerpo de excepción: el `message` string es el texto accionable del server.
  const detail = Array.isArray(body.message) ? body.message[0] : body.message;
  return {
    message,
    error: {
      code: 'SERVER_ERROR',
      message:
        typeof detail === 'string' && detail.trim()
          ? detail
          : `El servidor respondió ${httpStatus}. Reintentá.`,
    },
    httpStatus,
  };
}

/** Objeto (no función suelta) para poder espiarlo/anularlo en tests. */
export const authRedirect = {
  trigger(): void {
    if (typeof window === 'undefined') return;
    // window.location INCLUYE el basePath (el router de Next no) — todo acá
    // se maneja en coordenadas absolutas del browser.
    if (window.location.pathname.startsWith(`${BASE_PATH}/login`)) return; // sin loops
    const next = window.location.pathname + window.location.search;
    window.location.assign(`${BASE_PATH}/login?next=${encodeURIComponent(next)}`);
  },
};

function handleUnauthorized(): never {
  authRedirect.trigger();
  throw new UnauthorizedError();
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include', // la sesión viaja en cookie httpOnly
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    // El backend siempre manda un message accionable — mostrarlo, no el status.
    const data = (await res.json().catch(() => ({}))) as { message?: string | string[] };
    const message = Array.isArray(data.message) ? data.message[0] : data.message;
    throw new Error(message ?? `${init?.method ?? 'GET'} ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

/** POST /auth/* leyendo el mensaje del server (mensaje único de login, 429…). */
async function authPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  if (!res.ok) {
    const message = Array.isArray(data.message) ? data.message[0] : data.message;
    throw new Error(message ?? `Error ${res.status} — probá de nuevo`);
  }
  return data as T;
}

export interface ConversationListOptions {
  filter: 'open' | 'all' | 'closed' | 'expiring' | 'unread';
  assignedToMe?: boolean;
  cursor?: string | null;
  q?: string | null;
}

/** Pura y exportada: los params del GET /conversations se testean solos. */
export function conversationQueryParams(options: ConversationListOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (options.filter !== 'open') params.set('status', options.filter);
  if (options.assignedToMe) params.set('assignedToMe', 'true');
  if (options.cursor) params.set('cursor', options.cursor);
  const q = options.q?.trim();
  if (q) params.set('q', q);
  return params;
}

/** Respuesta de GET /auth/me (contrato fase 8). */
interface AuthMeResponse {
  user: AuthUser;
  tenant: { id: string; slug: string; name: string; timezone: string };
  features?: { transcription?: boolean };
}

function toMe(response: AuthMeResponse): Me {
  return {
    tenantId: response.tenant.id,
    userId: response.user.id,
    tenantName: response.tenant.name,
    timezone: response.tenant.timezone,
    name: response.user.name,
    email: response.user.email,
    role: response.user.role,
    mustChangePassword: response.user.mustChangePassword,
    features: { transcription: response.features?.transcription ?? false },
  };
}

export const api = {
  me: async (): Promise<Me> => toMe(await json<AuthMeResponse>(API_ROUTES.authMe)),

  auth: {
    login: (email: string, password: string) =>
      authPost<{ user: AuthUser }>(API_ROUTES.authLogin, { email, password }),
    logout: () => authPost<{ ok: true }>(API_ROUTES.authLogout, {}),
    changePassword: (currentPassword: string, newPassword: string) =>
      authPost<{ user: AuthUser }>(API_ROUTES.authChangePassword, {
        currentPassword,
        newPassword,
      }),
  },

  users: {
    manage: () => json<ManagedUser[]>(`${API_ROUTES.users}?management=true`),
    create: (input: { email: string; name: string; role: string; password: string }) =>
      json<ManagedUser>(API_ROUTES.users, { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: { name?: string; role?: string; isActive?: boolean }) =>
      json<ManagedUser>(API_ROUTES.user(id), { method: 'PATCH', body: JSON.stringify(input) }),
  },

  /** Deep-link Gourmetify (ex wa.me): abre o crea la conversación del teléfono. */
  openByPhone: (phone: string) =>
    json<{ conversation: Conversation }>(API_ROUTES.conversationOpenByPhone, {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  listConversations: (options: ConversationListOptions) =>
    json<{ conversations: Conversation[]; nextCursor: string | null; timezone: string }>(
      `${API_ROUTES.conversations}?${conversationQueryParams(options)}`,
    ),

  listUsers: () => json<AgentUser[]>(API_ROUTES.users),

  updateContactNotes: (contactId: string, notes: string | null) =>
    json<{ contact: Contact }>(API_ROUTES.contact(contactId), {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }),

  autoReply: {
    get: () => json<AutoReplyConfig>(API_ROUTES.autoReplySettings),
    update: (config: AutoReplyConfig) =>
      json<AutoReplyConfig>(API_ROUTES.autoReplySettings, {
        method: 'PUT',
        body: JSON.stringify(config),
      }),
  },

  /** Transcripción bajo demanda; el resultado también llega por message.updated. */
  transcribe: (messageId: string) =>
    json<{ message: Message; cached: boolean }>(API_ROUTES.messageTranscribe(messageId), {
      method: 'POST',
    }),

  listOrders: (conversationId: string) =>
    json<{ active: GourmetifyOrder[]; recent: GourmetifyOrder[] }>(
      API_ROUTES.conversationOrders(conversationId),
    ),

  listMessages: (conversationId: string, cursor?: string) =>
    json<{ messages: Message[]; nextCursor: string | null }>(
      `${API_ROUTES.conversationMessages(conversationId)}${
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),

  markRead: (conversationId: string) =>
    json<{ conversation: Conversation }>(API_ROUTES.conversationRead(conversationId), {
      method: 'POST',
    }),

  markUnread: (conversationId: string) =>
    json<{ conversation: Conversation }>(API_ROUTES.conversationUnread(conversationId), {
      method: 'POST',
    }),

  assign: (conversationId: string, userId: string | null) =>
    json<{ conversation: Conversation }>(API_ROUTES.conversationAssign(conversationId), {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  setStatus: (conversationId: string, status: 'OPEN' | 'CLOSED') =>
    json<{ conversation: Conversation }>(API_ROUTES.conversationStatus(conversationId), {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  listTemplates: () => json<Template[]>(API_ROUTES.templates),

  quickReplies: {
    list: (includeInactive = false) =>
      json<QuickReply[]>(
        `${API_ROUTES.quickReplies}${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    create: (input: { shortcut: string; title: string; body: string }) =>
      json<QuickReply>(API_ROUTES.quickReplies, { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: Partial<QuickReply>) =>
      json<QuickReply>(API_ROUTES.quickReply(id), { method: 'PATCH', body: JSON.stringify(input) }),
    deactivate: (id: string) =>
      json<{ ok: true }>(API_ROUTES.quickReply(id), { method: 'DELETE' }),
  },

  /**
   * Envío: el envelope { message, error } llega con CUALQUIER status HTTP —
   * no se tira en 4xx/5xx (el caller decide por error.code). Un throw acá
   * es solo fallo de RED → el composer reintenta con la MISMA key.
   * Excepción única: 401 = sin sesión → flujo de logout, no reintento.
   */
  sendMessage: async (
    conversationId: string,
    body:
      | { clientDedupKey: string; type: 'text'; body: string }
      | { clientDedupKey: string; type: 'template'; templateId: string; params: string[] },
  ): Promise<SendResult> => {
    const res = await fetch(`${API_BASE}${API_ROUTES.conversationMessages(conversationId)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) handleUnauthorized();
    return parseSendEnvelope(await res.json().catch(() => null), res.status);
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
      xhr.open('POST', `${API_BASE}${API_ROUTES.conversationMedia(conversationId)}`);
      xhr.withCredentials = true; // cookie de sesión
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          authRedirect.trigger();
          reject(new UnauthorizedError());
          return;
        }
        let raw: unknown = null;
        try {
          raw = JSON.parse(xhr.responseText);
        } catch {
          raw = null; // 502 del proxy, body vacío… lo resuelve parseSendEnvelope
        }
        resolve(parseSendEnvelope(raw, xhr.status));
      };
      xhr.onerror = () => reject(new Error('network')); // red → misma key
      xhr.send(form);
    }),

  mediaUrl: (messageId: string) => `${API_BASE}${API_ROUTES.messageMedia(messageId)}`,
};
