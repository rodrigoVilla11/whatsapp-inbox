/**
 * Estructura de key con tenant PRIMERO:
 *   {tenantId}/{conversationId}/{messageId}/{filename-sanitizado}
 * Así el borrado por tenant o por conversación es un borrado por prefijo.
 */
export function buildMediaKey(
  tenantId: string,
  conversationId: string,
  messageId: string,
  filename: string,
): string {
  return `${tenantId}/${conversationId}/${messageId}/${sanitizeFilename(filename)}`;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo';
  const clean = base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || 'archivo';
}

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** Filename derivado cuando el mensaje no trae uno (media que no es document). */
export function defaultFilenameFor(mimeType: string | null): string {
  const bare = (mimeType ?? '').split(';')[0].trim();
  return `media.${MIME_EXTENSION[bare] ?? 'bin'}`;
}
