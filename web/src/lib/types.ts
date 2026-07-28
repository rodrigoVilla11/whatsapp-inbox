/** DTOs del backend (contrato de fases 6/7a). Fechas como ISO strings. */

export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
export type MediaStatus = 'PENDING' | 'DOWNLOADED' | 'FAILED' | null;

export interface Message {
  id: string;
  conversationId: string;
  wamid: string | null;
  clientDedupKey: string | null;
  direction: MessageDirection;
  type: string;
  status: MessageStatus;
  body: string | null;
  replyToWamid: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  mediaSizeBytes: number | null;
  mediaStatus: MediaStatus;
  /** Transcripción del audio (bajo demanda; null = todavía no pedida). */
  transcription: string | null;
  /** true = lo mandó el sistema (auto-respuesta fuera de horario). */
  isAutoReply: boolean;
  errorCode: number | null;
  errorTitle: string | null;
  errorDetail: string | null;
  sentByUserId: string | null;
  timestamp: string;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  createdAt: string;
  /** Solo client-side: mensaje optimista aún sin confirmar / fallo de red local. */
  _local?: 'sending' | 'failed-network';
}

export interface Contact {
  id: string;
  waId: string;
  phoneE164: string | null;
  profileName: string | null;
  notes: string | null;
  isBlocked: boolean;
}

export interface Conversation {
  id: string;
  contactId: string;
  whatsappAccountId: string;
  status: 'OPEN' | 'PENDING' | 'CLOSED';
  assignedUserId: string | null;
  unreadCount: number;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  /** Calculados por el SERVIDOR — la UI nunca los deriva con su reloj. */
  isWindowOpen: boolean;
  windowExpiresAt: string | null;
  contact?: Contact | null;
  /** Solo en el listado REST (los eventos WS no lo traen; el merge lo preserva). */
  hasActiveOrder?: boolean;
}

export interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  bodyText: string;
  variableCount: number;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  isActive: boolean;
  /** Chip arriba del composer (máx 4 por tenant). */
  isFavorite: boolean;
}

/** DTO de GET /users — solo lo que el selector de asignación necesita. */
export interface AgentUser {
  id: string;
  name: string;
  role: string;
}

/** DTO del usuario logueado (fase 8: /auth/login y /auth/me). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'AGENT';
  mustChangePassword: boolean;
}

/** DTO de GET /users?management=true (ADMIN+): gestión de usuarios. */
export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'AGENT';
  isActive: boolean;
  mustChangePassword: boolean;
}

/** Identidad + tenant del bootstrap (mapeado de GET /auth/me). */
export interface Me {
  tenantId: string;
  userId: string | null;
  tenantName: string | null;
  timezone: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'AGENT';
  mustChangePassword: boolean;
  /** Capacidades habilitadas en el server (la UI esconde lo que no hay). */
  features: { transcription: boolean };
}

/** Envelope de envío del backend: { message, error } SIEMPRE. */
export interface SendEnvelope {
  message: Message | null;
  error: { code: string; message: string; windowExpiresAt?: string | null } | null;
}

export interface SendResult extends SendEnvelope {
  httpStatus: number;
}

/**
 * Pedido de Gourmetify espejado en el inbox (contrato display-ready: los
 * *Label se muestran tal cual; statusKind es lo único que la UI interpreta).
 */
export type OrderStatusKind = 'pending' | 'in_progress' | 'ready' | 'done' | 'cancelled';

export interface GourmetifyOrder {
  id: string;
  gourmetifyOrderId: string;
  contactId: string | null;
  number: string | null;
  statusLabel: string;
  statusKind: OrderStatusKind;
  summary: string | null;
  totalLabel: string | null;
  deliveryLabel: string | null;
  scheduledLabel: string | null;
  orderCreatedAt: string;
}

export interface OrderUpdatedEvent {
  order: GourmetifyOrder;
  contactId: string | null;
}

/** Config de auto-respuesta fuera de horario (Ajustes, ADMIN+). */
export interface AutoReplyRange {
  from: string; // "HH:MM"
  to: string;
}

export interface AutoReplyConfig {
  enabled: boolean;
  message: string;
  /** '0' (Dom) … '6' (Sáb) → hasta 2 rangos; [] = cerrado. */
  schedule: Record<string, AutoReplyRange[]>;
}

// Eventos WS (contrato fase 6)
export interface MessageCreatedEvent {
  conversationId: string;
  message: Message;
}
export interface MessageUpdatedEvent {
  id: string;
  conversationId: string;
  changes: Partial<Message>;
}
export interface ConversationUpdatedEvent {
  conversation: Conversation;
}
