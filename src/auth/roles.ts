import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { getTenantContext } from '../tenant/tenant-context';

/**
 * Matriz de roles (fase 8) — jerarquía simple, sin permisos sueltos:
 *   AGENT: operar conversaciones (ver/responder, asignarse, cerrar/reabrir,
 *          notas, marcar leído, ver plantillas y quick replies).
 *   ADMIN: + CRUD de quick replies, sync de plantillas, asignar a otros,
 *          alta/gestión de usuarios AGENT.
 *   OWNER: + gestión de ADMINs (y futura config de cuenta WhatsApp).
 * El backend es la autoridad: la UI solo esconde botones.
 */

const ROLE_RANK: Record<UserRole, number> = { AGENT: 0, ADMIN: 1, OWNER: 2 };

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

const MIN_ROLE_KEY = 'auth:minRole';

/** `@MinRole('ADMIN')` sobre un handler (o controller entero). */
export const MinRole = (role: UserRole) => SetMetadata(MIN_ROLE_KEY, role);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const minimum = this.reflector.getAllAndOverride<UserRole | undefined>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!minimum) return true; // sin decorador: alcanza con la sesión

    const request = context.switchToHttp().getRequest<Request>();
    const { role } = getTenantContext(request);
    if (!roleAtLeast(role, minimum)) {
      throw new ForbiddenException(
        `Esta acción necesita rol ${minimum} — tu rol es ${role}. Pedile a un administrador.`,
      );
    }
    return true;
  }
}
