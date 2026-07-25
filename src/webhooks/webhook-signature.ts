import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validación de X-Hub-Signature-256 de Meta.
 *
 * La firma es HMAC-SHA256 del RAW BODY exacto que mandó Meta, con el app
 * secret. Firmar sobre el objeto parseado y re-serializado NUNCA coincide
 * (orden de claves, espacios, unicode) — por eso estas funciones reciben
 * un Buffer y no un objeto. Hay un test que fija esta propiedad.
 */

const SIGNATURE_PREFIX = 'sha256=';
const HMAC_HEX_LENGTH = 64; // SHA-256 → 32 bytes → 64 chars hex

/** Firma un raw body como lo hace Meta. Para tests y tooling local. */
export function computeMetaSignature(rawBody: Buffer, appSecret: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  appSecret: string,
  header: string | string[] | undefined,
): boolean {
  if (!rawBody || rawBody.length === 0) return false;
  if (typeof header !== 'string' || !header.startsWith(SIGNATURE_PREFIX)) return false;

  const providedHex = header.slice(SIGNATURE_PREFIX.length);
  // Hex bien formado y de longitud exacta ANTES de decodificar:
  // Buffer.from(x, 'hex') no tira ante basura, la trunca en silencio.
  if (providedHex.length !== HMAC_HEX_LENGTH || !/^[0-9a-f]+$/i.test(providedHex)) {
    return false;
  }

  const provided = Buffer.from(providedHex, 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  // timingSafeEqual TIRA si las longitudes difieren; el chequeo de longitud
  // de arriba lo garantiza, este if es el cinturón explícito.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Comparación de strings en tiempo constante (verify token del GET). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
