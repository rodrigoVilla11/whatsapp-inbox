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
}

export interface Me {
  tenantId: string;
  userId: string | null;
  tenantName: string | null;
  timezone: string;
}

/** Envelope de envío del backend: { message, error } SIEMPRE. */
export interface SendEnvelope {
  message: Message | null;
  error: { code: string; message: string; windowExpiresAt?: string | null } | null;
}

export interface SendResult extends SendEnvelope {
  httpStatus: number;
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
