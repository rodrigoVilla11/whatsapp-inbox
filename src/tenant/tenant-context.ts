import { UnauthorizedException } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

/**
 * Contexto de tenant por request — desde fase 8 sale SIEMPRE de la sesión
 * (SessionAuthMiddleware). El provisional "tenant del seed" murió con ella.
 */
export interface TenantContext {
  tenantId: string;
  userId: string;
  role: UserRole;
  mustChangePassword: boolean;
  /** id de la fila Session (para logout selectivo / revocar el resto). */
  sessionId: string;
}

type RequestWithContext = Request & { tenantContext?: TenantContext };

export function setTenantContext(req: Request, context: TenantContext): void {
  (req as RequestWithContext).tenantContext = context;
}

export function getTenantContext(req: Request): TenantContext {
  const context = (req as RequestWithContext).tenantContext;
  if (!context) {
    // Solo posible si una ruta del dominio olvidó el SessionAuthMiddleware.
    throw new UnauthorizedException('Necesitás iniciar sesión');
  }
  return context;
}
