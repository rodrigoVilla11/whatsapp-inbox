/**
 * Techos de tamaño por categoría de media, configurables por env.
 * Defaults alineados a los límites reales de WhatsApp Cloud API.
 */
export type MediaCategory = 'image' | 'video' | 'audio' | 'document' | 'sticker';

const DEFAULT_MAX_MB: Record<MediaCategory, number> = {
  image: 5,
  video: 16,
  audio: 16,
  document: 100,
  sticker: 1,
};

const ENV_VAR: Record<MediaCategory, string> = {
  image: 'MEDIA_MAX_IMAGE_MB',
  video: 'MEDIA_MAX_VIDEO_MB',
  audio: 'MEDIA_MAX_AUDIO_MB',
  document: 'MEDIA_MAX_DOCUMENT_MB',
  sticker: 'MEDIA_MAX_STICKER_MB',
};

export function mediaCategoryFor(mimeType: string | null | undefined): MediaCategory {
  const bare = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (bare === 'image/webp') return 'sticker';
  if (bare.startsWith('image/')) return 'image';
  if (bare.startsWith('video/')) return 'video';
  if (bare.startsWith('audio/')) return 'audio';
  return 'document';
}

export function maxBytesFor(
  mimeType: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const category = mediaCategoryFor(mimeType);
  const fromEnv = Number(env[ENV_VAR[category]]);
  const mb = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_MB[category];
  return Math.floor(mb * 1024 * 1024);
}

/** El techo absoluto (multer) es el mayor de todos: el fino se chequea después. */
export function absoluteMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(
    ...(['image', 'video', 'audio', 'document', 'sticker'] as MediaCategory[]).map((c) =>
      maxBytesFor(c === 'image' ? 'image/jpeg' : `${c}/x`, env),
    ),
  );
}

export class MediaTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Media de ${actualBytes} bytes excede el máximo de ${maxBytes}`);
    this.name = 'MediaTooLargeError';
  }
}

/**
 * Content-types soportados para MEDIA SALIENTE (allowlist de WhatsApp).
 * webp (stickers) queda fuera del envío por ahora, a propósito.
 */
export const OUTBOUND_MEDIA_TYPES: Record<
  string,
  { kind: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' }
> = {
  'image/jpeg': { kind: 'IMAGE' },
  'image/png': { kind: 'IMAGE' },
  'video/mp4': { kind: 'VIDEO' },
  'video/3gpp': { kind: 'VIDEO' },
  'audio/aac': { kind: 'AUDIO' },
  'audio/mp4': { kind: 'AUDIO' },
  'audio/mpeg': { kind: 'AUDIO' },
  'audio/amr': { kind: 'AUDIO' },
  'audio/ogg': { kind: 'AUDIO' },
  'application/pdf': { kind: 'DOCUMENT' },
  'application/msword': { kind: 'DOCUMENT' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'DOCUMENT' },
  'application/vnd.ms-excel': { kind: 'DOCUMENT' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'DOCUMENT' },
  'application/vnd.ms-powerpoint': { kind: 'DOCUMENT' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: 'DOCUMENT',
  },
  'text/plain': { kind: 'DOCUMENT' },
};
