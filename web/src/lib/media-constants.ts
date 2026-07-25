/**
 * Techos y allowlist de media CLIENT-SIDE.
 *
 * Elección documentada: constantes espejo de los defaults del backend
 * (src/media/media-limits.ts) en lugar de un GET /config — un endpoint de
 * config para 5 números fijos no paga su costo hoy; si los techos se
 * vuelven configurables por tenant, se migra a GET /config. El BACKEND es
 * la autoridad: esto solo evita subir 80MB para recibir un 413.
 */
export const MAX_MB: Record<'image' | 'video' | 'audio' | 'document', number> = {
  image: 5,
  video: 16,
  audio: 16,
  document: 100,
};

/** Espejo de OUTBOUND_MEDIA_TYPES del backend. */
export const OUTBOUND_TYPES: Record<string, 'image' | 'video' | 'audio' | 'document'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'audio/aac': 'audio',
  'audio/mp4': 'audio',
  'audio/mpeg': 'audio',
  'audio/amr': 'audio',
  'audio/ogg': 'audio',
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'text/plain': 'document',
};

export function validateFile(file: File): string | null {
  const kind = OUTBOUND_TYPES[file.type];
  if (!kind) return `Tipo de archivo no soportado por WhatsApp (${file.type || 'desconocido'})`;
  const maxBytes = MAX_MB[kind] * 1024 * 1024;
  if (file.size > maxBytes) {
    return `El archivo supera el máximo de ${MAX_MB[kind]}MB para ${kind}`;
  }
  return null;
}
