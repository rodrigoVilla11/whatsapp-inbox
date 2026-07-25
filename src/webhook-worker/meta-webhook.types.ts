/**
 * Formas del payload de webhooks de WhatsApp Cloud API que consumimos.
 * TODO opcional a propósito: es input externo no confiable — el worker
 * valida en runtime, los tipos solo documentan la estructura esperada.
 */

export interface MetaWebhookPayload {
  object?: string;
  entry?: MetaEntry[];
}

export interface MetaEntry {
  id?: string; // WABA id
  changes?: MetaChange[];
}

export interface MetaChange {
  field?: string; // 'messages' es el que procesamos
  value?: MetaChangeValue;
}

export interface MetaChangeValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string; // ← clave de resolución de tenant
  };
  contacts?: MetaContact[];
  messages?: MetaInboundMessage[];
  statuses?: MetaStatus[];
}

export interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

export interface MetaMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string; // solo document
  animated?: boolean;
  voice?: boolean;
}

export interface MetaInboundMessage {
  from?: string; // wa_id del cliente
  id?: string; // wamid
  timestamp?: string; // epoch en SEGUNDOS, como string
  type?: string;
  text?: { body?: string };
  image?: MetaMedia;
  video?: MetaMedia;
  audio?: MetaMedia;
  document?: MetaMedia;
  sticker?: MetaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: unknown[];
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  system?: { body?: string; type?: string };
  context?: { from?: string; id?: string };
  errors?: MetaError[];
  [key: string]: unknown;
}

export interface MetaStatus {
  id?: string; // wamid del mensaje saliente al que refiere
  status?: string; // sent | delivered | read | failed
  timestamp?: string; // epoch en segundos
  recipient_id?: string;
  conversation?: {
    id?: string;
    origin?: { type?: string };
    expiration_timestamp?: string;
  };
  pricing?: MetaPricing;
  errors?: MetaError[];
}

export interface MetaPricing {
  billable?: boolean;
  pricing_model?: string;
  category?: string;
  type?: string;
}

export interface MetaError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}
