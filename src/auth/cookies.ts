import type { CookieOptions, Response } from 'express';

/**
 * La cookie de sesión — POR QUÉ cookie y no JWT en header: las imágenes del
 * hilo se cargan con <img src="/messages/:id/media"> que sigue un 302
 * firmado; el navegador no puede adjuntar un Authorization header a un
 * <img>, pero manda cookies solo. Además: revocación inmediata borrando la
 * fila de Session, y cero estado sensible en el cliente.
 *
 * httpOnly (JS nunca la lee), SameSite=Lax (no viaja en POSTs cross-site),
 * Secure en producción. Sin maxAge de años: 30 días sliding (renovada con
 * uso) — la autoridad de expiración es la fila de Session, la cookie solo
 * acompaña.
 */
export const SESSION_COOKIE = 'inbox_session';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
}

/** Parser mínimo del header Cookie (no hace falta cookie-parser). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}
