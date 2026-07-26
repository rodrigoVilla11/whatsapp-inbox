import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { corsOrigins } from '../http/cors';
import { setTenantContext } from '../tenant/tenant-context';
import { parseCookies, SESSION_COOKIE } from './cookies';
import { SessionsService } from './sessions.service';

/**
 * Auth de sesión para TODO endpoint del dominio: cookie válida o 401.
 * Se aplica por módulo (inbox, media, messaging, users, auth/me) — los
 * webhooks de Meta quedan EXPLÍCITAMENTE afuera: su auth es la firma HMAC
 * (x-hub-signature-256), no una sesión de usuario.
 *
 * CSRF — razonamiento documentado: la cookie es SameSite=Lax, así que un
 * POST desde otro sitio no la lleva en ningún navegador moderno, y la API
 * no muta nada por GET. El riesgo residual (navegadores viejos, Lax
 * degradado) se cubre con este cinturón: en mutaciones, si viene Origin (o
 * Referer) y hay allowlist de CORS configurada, el origen debe estar en la
 * lista. Requests sin Origin (curl, server-to-server) pasan — sin cookie no
 * son un CSRF, y con cookie robada el CSRF ya no es el problema.
 */
@Injectable()
export class SessionAuthMiddleware implements NestMiddleware {
  constructor(private readonly sessions: SessionsService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = await this.sessions.validate(token);
    if (!session) {
      throw new UnauthorizedException('Necesitás iniciar sesión');
    }

    if (!SAFE_METHODS.has(req.method)) assertOriginAllowed(req);

    setTenantContext(req, {
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
      sessionId: session.sessionId,
    });
    next();
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function assertOriginAllowed(req: Request): void {
  const allowed = corsOrigins();
  if (allowed === true) return; // sin allowlist (dev): no hay contra qué chequear

  const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
  if (!origin) return; // clientes no-browser: sin Origin no hay CSRF posible

  // El PROPIO origen siempre pasa (producción es un solo origen — fase 10b):
  // el Host del request es la verdad de "quiénes somos" detrás del proxy.
  try {
    if (new URL(origin).host === req.headers.host) return;
  } catch {
    // origin imparseable → sigue al allowlist
  }
  if (!allowed.includes(origin)) {
    throw new ForbiddenException('Origen no permitido para esta operación');
  }
}

function refererOrigin(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
