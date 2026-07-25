import { Injectable, NestMiddleware, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantContext, TenantContextService } from './tenant-context.service';

export type { TenantContext } from './tenant-context.service';

/**
 * TODO(auth): PROVISORIO — fija el contexto vía TenantContextService (tenant
 * del seed + OWNER). Cuando exista auth real, este middleware pasa a sacar
 * tenantId/userId de la sesión; el resto del código ya consume TenantContext
 * y no cambia.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const context = await this.tenantContext.resolveDefault();
    if (!context) {
      throw new ServiceUnavailableException(
        'Tenant por defecto no existe — ¿corriste npm run db:seed?',
      );
    }
    (req as Request & { tenantContext: TenantContext }).tenantContext = context;
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
