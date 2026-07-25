import { Injectable, NestMiddleware, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export interface TenantContext {
  tenantId: string;
  userId: string | null;
}

/**
 * TODO(auth): PROVISORIO hasta montar auth real (sesión/JWT por tenant).
 *
 * Fija el contexto al tenant del seed (DEFAULT_TENANT_SLUG, default
 * nova-sushi) y a su usuario OWNER como sentByUserId. Cuando exista auth,
 * este middleware se reemplaza por el que saque tenantId/userId de la
 * sesión — el resto del código ya consume TenantContext y no cambia.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private cached: TenantContext | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!this.cached) {
      const slug = process.env.DEFAULT_TENANT_SLUG ?? 'nova-sushi';
      const tenant = await this.prisma.db.tenant.findUnique({ where: { slug } });
      if (!tenant) {
        throw new ServiceUnavailableException(
          `Tenant "${slug}" no existe — ¿corriste npm run db:seed?`,
        );
      }
      const owner = await this.prisma.db.user.findFirst({
        where: { tenantId: tenant.id, role: 'OWNER', isActive: true },
      });
      this.cached = { tenantId: tenant.id, userId: owner?.id ?? null };
    }
    (req as Request & { tenantContext: TenantContext }).tenantContext = this.cached;
    next();
  }
}

export function getTenantContext(req: Request): TenantContext {
  const context = (req as Request & { tenantContext?: TenantContext }).tenantContext;
  if (!context) {
    // Solo puede pasar si una ruta olvidó registrar el middleware.
    throw new ServiceUnavailableException('TenantContext no inicializado para esta ruta');
  }
  return context;
}
