/**
 * Cursor opaco para paginación keyset: base64url de { t, id }.
 * t = timestamp del campo de orden (ISO o null), id desempata.
 */
export interface Cursor {
  t: string | null;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed?.id !== 'string') return null;
    return { t: typeof parsed.t === 'string' ? parsed.t : null, id: parsed.id };
  } catch {
    return null; // cursor corrupto = primera página, no un 500
  }
}
