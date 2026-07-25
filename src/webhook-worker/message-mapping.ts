import type { MessageType } from '@prisma/client';
import type { MetaInboundMessage } from './meta-webhook.types';

export const PREVIEW_MAX_CHARS = 120;

const META_TYPE_TO_MESSAGE_TYPE: Record<string, MessageType> = {
  text: 'TEXT',
  image: 'IMAGE',
  document: 'DOCUMENT',
  audio: 'AUDIO',
  video: 'VIDEO',
  sticker: 'STICKER',
  location: 'LOCATION',
  contacts: 'CONTACTS',
  button: 'BUTTON',
  interactive: 'INTERACTIVE',
  reaction: 'REACTION',
  system: 'SYSTEM',
};

/** Tipo desconocido → UNSUPPORTED (y el mensaje conserva su raw). */
export function mapMetaMessageType(metaType: string | undefined): MessageType {
  return (metaType && META_TYPE_TO_MESSAGE_TYPE[metaType]) || 'UNSUPPORTED';
}

/**
 * Meta manda timestamps como string de epoch en SEGUNDOS. El bug clásico es
 * pasarlos directo a new Date() (los interpreta como ms) y que todo quede
 * en enero de 1970: acá se multiplica ×1000, con test que lo fija.
 */
export function parseEpochSeconds(value: string | number | undefined): Date | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/** wa_id es E.164 sin '+' — se normaliza validando que sean solo dígitos. */
export function waIdToE164(waId: string): string | null {
  return /^\d{5,15}$/.test(waId) ? `+${waId}` : null;
}

const MEDIA_TYPES: ReadonlySet<MessageType> = new Set([
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'DOCUMENT',
  'STICKER',
]);

export interface MappedInboundMessage {
  type: MessageType;
  body: string | null;
  replyToWamid: string | null;
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaSha256: string | null;
  mediaFilename: string | null;
  hasMedia: boolean;
  isReaction: boolean;
  /** raw solo se persiste para UNSUPPORTED o mensajes con error (regla de fase 1). */
  keepRaw: boolean;
  errorCode: number | null;
  errorTitle: string | null;
  errorDetail: string | null;
}

export function mapInboundMessage(msg: MetaInboundMessage): MappedInboundMessage {
  const type = mapMetaMessageType(msg.type);
  const media = msg.type ? (msg[msg.type] as MetaInboundMessage['image']) : undefined;
  const hasMedia = MEDIA_TYPES.has(type);

  let body: string | null = null;
  switch (type) {
    case 'TEXT':
      body = msg.text?.body ?? null;
      break;
    case 'IMAGE':
    case 'VIDEO':
    case 'DOCUMENT':
    case 'AUDIO':
    case 'STICKER':
      body = media?.caption ?? null;
      break;
    case 'LOCATION':
      // Sin raw para tipos conocidos: lo estructurado que la UI necesita
      // (lat/lng para el link de mapa) viaja como JSON en body. Deliberado.
      body = msg.location ? JSON.stringify(msg.location) : null;
      break;
    case 'CONTACTS':
      body = msg.contacts ? JSON.stringify(msg.contacts) : null;
      break;
    case 'BUTTON':
      body = msg.button?.text ?? null;
      break;
    case 'INTERACTIVE':
      body = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
      break;
    case 'REACTION':
      body = msg.reaction?.emoji ?? null;
      break;
    case 'SYSTEM':
      body = msg.system?.body ?? null;
      break;
    default:
      body = null;
  }

  const firstError = msg.errors?.[0];
  const errorCode = firstError?.code ?? null;

  return {
    type,
    body,
    // reaction referencia al mensaje reaccionado; el resto usa context.id
    // (respuesta citada).
    replyToWamid: msg.reaction?.message_id ?? msg.context?.id ?? null,
    mediaId: hasMedia ? (media?.id ?? null) : null,
    mediaMimeType: hasMedia ? (media?.mime_type ?? null) : null,
    mediaSha256: hasMedia ? (media?.sha256 ?? null) : null,
    mediaFilename: type === 'DOCUMENT' ? (media?.filename ?? null) : null,
    hasMedia,
    isReaction: type === 'REACTION',
    keepRaw: type === 'UNSUPPORTED' || errorCode !== null,
    errorCode,
    errorTitle: firstError?.title ?? null,
    errorDetail: firstError?.error_data?.details ?? firstError?.message ?? null,
  };
}

/**
 * Preview para la lista de conversaciones. Decisión deliberada sobre
 * reacciones: SÍ pisan el preview ("Reaccionó 👍") — la cajera ve actividad
 * nueva — pero NO incrementan unreadCount (eso lo decide el service).
 */
export function buildMessagePreview(mapped: MappedInboundMessage): string {
  const truncate = (s: string): string =>
    s.length > PREVIEW_MAX_CHARS ? `${s.slice(0, PREVIEW_MAX_CHARS - 1)}…` : s;

  switch (mapped.type) {
    case 'IMAGE':
      return truncate(mapped.body ? `📷 ${mapped.body}` : '📷 Imagen');
    case 'VIDEO':
      return truncate(mapped.body ? `🎥 ${mapped.body}` : '🎥 Video');
    case 'AUDIO':
      return '🎙️ Audio';
    case 'STICKER':
      return 'Sticker';
    case 'DOCUMENT':
      return truncate(mapped.mediaFilename ? `📄 ${mapped.mediaFilename}` : '📄 Documento');
    case 'LOCATION':
      return '📍 Ubicación';
    case 'CONTACTS':
      return '👤 Contacto compartido';
    case 'REACTION':
      return mapped.body ? truncate(`Reaccionó ${mapped.body}`) : 'Quitó una reacción';
    case 'UNSUPPORTED':
      return 'Mensaje no soportado';
    default:
      return truncate(mapped.body ?? mapped.type);
  }
}
