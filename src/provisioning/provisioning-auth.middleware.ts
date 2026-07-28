import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  NestMiddleware,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Auth servicio-a-servicio del provisioning (backend de Gourmetify → inbox):
 * header `x-provisioning-key` contra PROVISIONING_SECRET. Sin la env, los
 * endpoints quedan DESHABILITADOS explícitamente (503) — nunca abiertos.
 * Nada de sesiones acá: no hay usuario, hay otro backend.
 */
@Injectable()
export class ProvisioningAuthMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const secret = process.env.PROVISIONING_SECRET?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(
        'Provisioning deshabilitado: falta PROVISIONING_SECRET en el entorno',
      );
    }
    const provided = req.headers['x-provisioning-key'];
    if (typeof provided !== 'string' || !safeEquals(provided, secret)) {
      throw new UnauthorizedException('Clave de provisioning inválida');
    }
    next();
  }
}

/** Comparación en tiempo constante (hasheando primero: largos distintos no filtran). */
function safeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
