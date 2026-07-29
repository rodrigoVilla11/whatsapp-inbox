import type { Contact, Conversation, Message } from '@prisma/client';
import { isWindowOpen, windowExpiresAt } from '../messaging/window';

/**
 * DTOs compartidos por REST y WS — el contrato único hacia el frontend.
 *
 * Message: allowlist explícita. Quedan afuera a propósito: raw, pricing,
 * tenantId, mediaUrl (es la KEY interna de R2 — la media se sirve por
 * GET /messages/:id/media), mediaId/mediaSha256 (internos de Meta),
 * templateParams, deletedAt, updatedAt.
 *
 * Conversation: incluye isWindowOpen y windowExpiresAt CALCULADOS POR EL
 * SERVIDOR. Regla para la UI: jamás calcular la ventana desde
 * lastInboundAt con el reloj local (la tablet puede tener la hora
 * corrida); el countdown visual es cosmético sobre windowExpiresAt.
 */
export function serializeMessage(m: Message): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversationId,
    wamid: m.wamid,
    clientDedupKey: m.clientDedupKey,
    direction: m.direction,
    type: m.type,
    status: m.status,
    body: m.body,
    replyToWamid: m.replyToWamid,
    templateName: m.templateName,
    templateLanguage: m.templateLanguage,
    mediaMimeType: m.mediaMimeType,
    mediaFilename: m.mediaFilename,
    mediaSizeBytes: m.mediaSizeBytes,
    mediaStatus: m.mediaStatus,
    transcription: m.transcription,
    isAutoReply: m.isAutoReply,
    errorCode: m.errorCode,
    errorTitle: m.errorTitle,
    errorDetail: m.errorDetail,
    sentByUserId: m.sentByUserId,
    timestamp: m.timestamp,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    failedAt: m.failedAt,
    createdAt: m.createdAt,
  };
}

export function serializeContact(c: Contact): Record<string, unknown> {
  return {
    id: c.id,
    waId: c.waId,
    phoneE164: c.phoneE164,
    profileName: c.profileName,
    notes: c.notes,
    isBlocked: c.isBlocked,
  };
}

/**
 * `contact` se embebe solo cuando el caller lo provee (listado REST); los
 * eventos WS mandan la conversación sin contacto y la UI conserva el que
 * ya tiene. El timezone del tenant viaja una sola vez en la respuesta del
 * listado, no por conversación.
 */
export function serializeConversation(
  c: Conversation,
  contact?: Contact | null,
): Record<string, unknown> {
  return {
    id: c.id,
    contactId: c.contactId,
    whatsappAccountId: c.whatsappAccountId,
    status: c.status,
    assignedUserId: c.assignedUserId,
    unreadCount: c.unreadCount,
    lastInboundAt: c.lastInboundAt,
    lastOutboundAt: c.lastOutboundAt,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    // Anclado compartido: la UI ordena los anclados arriba y muestra el 📌.
    pinnedAt: c.pinnedAt,
    createdAt: c.createdAt,
    isWindowOpen: isWindowOpen(c),
    windowExpiresAt: windowExpiresAt(c)?.toISOString() ?? null,
    ...(contact !== undefined ? { contact: contact ? serializeContact(contact) : null } : {}),
  };
}
