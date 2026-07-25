/**
 * Sniffing básico de magic bytes: el content-type declarado en el multipart
 * es del cliente y no se le cree. Para los tipos con firma conocida se
 * exige match; para los que no tienen firma confiable (txt, amr variantes)
 * se deja pasar. Un PNG declarado con bytes de JPEG → mismatch → 422.
 */

type Check = (buffer: Buffer) => boolean;

const startsWith =
  (bytes: number[], offset = 0): Check =>
  (buffer) =>
    buffer.length >= offset + bytes.length &&
    bytes.every((b, i) => buffer[offset + i] === b);

const ascii = (text: string, offset = 0): Check => startsWith([...text].map((c) => c.charCodeAt(0)), offset);

const SIGNATURES: Record<string, Check> = {
  'image/jpeg': startsWith([0xff, 0xd8, 0xff]),
  'image/png': startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': ascii('GIF8'),
  'image/webp': (b) => ascii('RIFF')(b) && ascii('WEBP', 8)(b),
  'application/pdf': ascii('%PDF'),
  'video/mp4': ascii('ftyp', 4),
  'video/3gpp': ascii('ftyp', 4),
  'audio/ogg': ascii('OggS'),
  'audio/mpeg': (b) => ascii('ID3')(b) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  // docx/xlsx/pptx son ZIP
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ascii('PK'),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ascii('PK'),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ascii('PK'),
};

export function magicBytesMatch(declaredMime: string, buffer: Buffer): boolean {
  const bare = declaredMime.split(';')[0].trim().toLowerCase();
  const check = SIGNATURES[bare];
  return check ? check(buffer) : true;
}
