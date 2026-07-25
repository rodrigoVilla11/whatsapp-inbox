import { GraphApiError } from '../whatsapp/graph-api.client';

/**
 * Códigos de dominio del envío. La UI decide por ESTE código, nunca por el
 * numérico de Meta ni por un toast genérico:
 * - WINDOW_EXPIRED        → pasar a modo plantilla (y el backend ya corrigió
 *                           la ventana local — Meta gana).
 * - RECIPIENT_UNREACHABLE → mostrar el motivo, no ofrecer reintento.
 * - RATE_LIMITED          → ofrecer reintentar (el backend ya reintentó 1 vez).
 * - ACCOUNT_ERROR         → la cuenta necesita reconexión; avisar al admin.
 * - SEND_FAILED           → error genérico de Meta con el código crudo.
 */
export type SendErrorCode =
  | 'WINDOW_EXPIRED'
  | 'RECIPIENT_UNREACHABLE'
  | 'RATE_LIMITED'
  | 'ACCOUNT_ERROR'
  | 'SEND_FAILED';

export interface MappedSendError {
  domainCode: SendErrorCode;
  /** Status HTTP hacia la UI. */
  httpStatus: number;
  /** Mensaje legible para quien opera el inbox. */
  userMessage: string;
  metaCode: number | null;
  metaTitle: string | null;
  metaDetail: string | null;
}

/** Códigos de Meta con manejo explícito. */
export const META_ERROR_WINDOW_EXPIRED = 131047;
export const META_ERROR_RECIPIENT_UNREACHABLE = 131026;
export const META_ERROR_RATE_LIMITED = 130429;
export const META_ERROR_INVALID_TOKEN = 190;

export function mapMetaSendError(error: GraphApiError): MappedSendError {
  const base = {
    metaCode: error.code,
    metaTitle: error.meta?.message ?? null,
    metaDetail: error.details,
  };

  switch (error.code) {
    case META_ERROR_WINDOW_EXPIRED:
      return {
        ...base,
        domainCode: 'WINDOW_EXPIRED',
        httpStatus: 422,
        userMessage:
          'La ventana de 24 horas está cerrada según WhatsApp. ' +
          'Para contactar a este cliente usá una plantilla aprobada.',
      };
    case META_ERROR_RECIPIENT_UNREACHABLE:
      return {
        ...base,
        domainCode: 'RECIPIENT_UNREACHABLE',
        httpStatus: 422,
        userMessage:
          'No se pudo entregar: el número puede no tener WhatsApp ' +
          'o haber bloqueado al negocio.',
      };
    case META_ERROR_RATE_LIMITED:
      return {
        ...base,
        domainCode: 'RATE_LIMITED',
        httpStatus: 429,
        userMessage: 'WhatsApp limitó los envíos por unos segundos. Probá de nuevo.',
      };
    default:
      break;
  }

  // Token vencido/revocado: Meta responde 401, usualmente con code 190.
  if (error.httpStatus === 401 || error.code === META_ERROR_INVALID_TOKEN) {
    return {
      ...base,
      domainCode: 'ACCOUNT_ERROR',
      httpStatus: 502,
      userMessage:
        'La conexión con WhatsApp expiró. Hay que reconectar la cuenta ' +
        'desde la configuración.',
    };
  }

  return {
    ...base,
    domainCode: 'SEND_FAILED',
    httpStatus: 502,
    userMessage: `WhatsApp rechazó el mensaje${error.code ? ` (código ${error.code})` : ''}.`,
  };
}

/** Errores que no vienen de Graph (red caída, timeout del fetch). */
export function mapTransportSendError(error: unknown): MappedSendError {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    domainCode: 'SEND_FAILED',
    httpStatus: 502,
    userMessage: 'No se pudo contactar a WhatsApp. Revisá la conexión y reintentá.',
    metaCode: null,
    metaTitle: null,
    metaDetail: detail,
  };
}
