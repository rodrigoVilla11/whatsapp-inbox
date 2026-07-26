import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenant/tenant-context';
import { hashPassword, passwordPolicyError } from './passwords';
import { SessionsService } from './sessions.service';

/**
 * Gestión mínima de usuarios (fase 8): lo justo para dar de alta a la
 * cajera. Reglas de la matriz que el guard de rol NO cubre (dependen del
 * rol del TARGET, no solo del caller):
 * - ADMIN gestiona solo AGENTs; los ADMINs los gestiona el OWNER.
 * - Nadie modifica al OWNER salvo él mismo (y su rol no se toca).
 * - Nadie se desactiva a sí mismo; desactivar mata todas las sesiones.
 */

function serializeUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** Cualquier rol: alimenta el selector de asignación (solo activos, DTO chico). */
  async listForAssignment(tenantId: string): Promise<unknown[]> {
    const rows = (await this.prisma.db.user.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ name: 'asc' }],
    })) as User[];
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role }));
  }

  /** ADMIN+: lista completa (incluye inactivos y email) para la gestión. */
  async listForManagement(tenantId: string): Promise<unknown[]> {
    const rows = (await this.prisma.db.user.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    })) as User[];
    return rows.map(serializeUser);
  }

  async create(
    caller: TenantContext,
    input: { email?: unknown; name?: unknown; role?: unknown; password?: unknown },
  ): Promise<unknown> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const role = input.role;
    const password = typeof input.password === 'string' ? input.password : '';

    if (!email || !email.includes('@')) throw new BadRequestException('Email inválido');
    if (!name) throw new BadRequestException('El nombre no puede quedar vacío');
    if (role !== 'AGENT' && role !== 'ADMIN') {
      throw new BadRequestException("El rol tiene que ser 'AGENT' o 'ADMIN'");
    }
    if (role === 'ADMIN' && caller.role !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño puede crear administradores');
    }
    const policyError = passwordPolicyError(password);
    if (policyError) throw new BadRequestException(policyError);

    const existing = await this.prisma.db.user.findFirst({
      where: { tenantId: caller.tenantId, email },
    });
    if (existing) throw new BadRequestException('Ya hay un usuario con ese email');

    const user = (await this.prisma.db.user.create({
      data: {
        tenantId: caller.tenantId,
        email,
        name,
        role: role as UserRole,
        passwordHash: await hashPassword(password),
        mustChangePassword: true, // password inicial comunicada por el admin
      },
    })) as User;
    return serializeUser(user);
  }

  async update(
    caller: TenantContext,
    targetId: string,
    input: { name?: unknown; role?: unknown; isActive?: unknown },
  ): Promise<unknown> {
    const target = (await this.prisma.db.user.findFirst({
      where: { id: targetId, tenantId: caller.tenantId },
    })) as User | null;
    if (!target) throw new NotFoundException(`Usuario ${targetId} no existe`);

    const editingSelf = target.id === caller.userId;
    if (target.role === 'OWNER' && !editingSelf) {
      throw new ForbiddenException('Al dueño solo lo edita el dueño');
    }
    if (target.role === 'ADMIN' && !editingSelf && caller.role !== 'OWNER') {
      throw new ForbiddenException('A un administrador solo lo gestiona el dueño');
    }

    const data: Partial<User> = {};

    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) throw new BadRequestException('El nombre no puede quedar vacío');
      data.name = name;
    }

    if (input.role !== undefined) {
      if (input.role !== 'AGENT' && input.role !== 'ADMIN') {
        throw new BadRequestException("El rol tiene que ser 'AGENT' o 'ADMIN'");
      }
      if (target.role === 'OWNER') {
        throw new ForbiddenException('El rol del dueño no se cambia desde acá');
      }
      if (caller.role !== 'OWNER' && input.role !== target.role) {
        throw new ForbiddenException('Solo el dueño cambia roles');
      }
      data.role = input.role as UserRole;
    }

    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean') {
        throw new BadRequestException('isActive tiene que ser booleano');
      }
      if (target.role === 'OWNER') {
        throw new ForbiddenException('El dueño no se desactiva');
      }
      if (editingSelf && input.isActive === false) {
        throw new BadRequestException('No podés desactivarte a vos mismo');
      }
      data.isActive = input.isActive;
    }

    await this.prisma.db.user.update({ where: { id: target.id }, data });
    if (data.isActive === false) {
      await this.sessions.revokeAllForUser(target.id); // 401 en su próximo request
    }
    const fresh = (await this.prisma.db.user.findFirst({
      where: { id: target.id, tenantId: caller.tenantId },
    })) as User;
    return serializeUser(fresh);
  }
}
