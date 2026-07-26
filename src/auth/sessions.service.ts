import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Session, User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_TTL_MS } from './cookies';

/**
 * Sesiones en Postgres (fase 8):
 * - Creación: token opaco de 256 bits → a la cookie; en la tabla va SOLO
 *   su sha256 (un dump de Session no fabrica cookies).
 * - Validación: hash del token → fila viva (expiresAt > now) → usuario
 *   isActive (desactivar un usuario mata su sesión en el PRÓXIMO request).
 * - Sliding: cada uso renueva expiresAt a now+30d, con throttle de escritura
 *   (una vez por hora como mucho — no un UPDATE por request).
 * - Revocación: borrar la fila (logout) o todas las del usuario
 *   (desactivación / "cerrar todas las sesiones").
 */

const TOUCH_THROTTLE_MS = 60 * 60 * 1000; // renovar como mucho 1 vez/hora

export interface AuthenticatedSession {
  tenantId: string;
  userId: string;
  role: UserRole;
  mustChangePassword: boolean;
  sessionId: string;
  user: User;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Resultado con RAZÓN — para diagnósticos que distinguen por qué falló. */
export type SessionValidation =
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; reason: 'no-token' | 'unknown-token' | 'expired' | 'user-inactive' };

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: Pick<User, 'id' | 'tenantId'>,
    userAgent: string | null,
    now: Date = new Date(),
  ): Promise<{ token: string }> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.db.session.create({
      data: {
        tokenHash: hashSessionToken(token),
        userId: user.id,
        tenantId: user.tenantId,
        userAgent: userAgent ? userAgent.slice(0, 255) : null,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    });
    return { token };
  }

  /** null = sin sesión utilizable (inexistente, vencida o usuario de baja). */
  async validate(
    token: string | undefined,
    now: Date = new Date(),
  ): Promise<AuthenticatedSession | null> {
    const result = await this.inspect(token, now);
    return result.ok ? result.session : null;
  }

  /**
   * Igual que validate pero DICE por qué falló — REST y WS validan por acá
   * (un solo camino de verdad: mismo hash, misma expiración, mismo isActive).
   */
  async inspect(token: string | undefined, now: Date = new Date()): Promise<SessionValidation> {
    if (!token) return { ok: false, reason: 'no-token' };
    const db = this.prisma.db;
    const session = (await db.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
    })) as Session | null;
    if (!session) return { ok: false, reason: 'unknown-token' };

    if (session.expiresAt.getTime() <= now.getTime()) {
      // vencida: se limpia en el acto, no queda basura viva
      await db.session.deleteMany({ where: { id: session.id } });
      return { ok: false, reason: 'expired' };
    }

    const user = (await db.user.findUnique({ where: { id: session.userId } })) as User | null;
    if (!user || !user.isActive) {
      // usuario de baja → la sesión muere acá, en el próximo request
      await db.session.deleteMany({ where: { id: session.id } });
      return { ok: false, reason: 'user-inactive' };
    }

    // Sliding con throttle: renovar solo si el último touch quedó viejo.
    if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_THROTTLE_MS) {
      await db.session.updateMany({
        where: { id: session.id },
        data: { lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
      });
    }

    return {
      ok: true,
      session: {
        tenantId: session.tenantId,
        userId: user.id,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        sessionId: session.id,
        user,
      },
    };
  }

  async revokeByToken(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.db.session.deleteMany({
      where: { tokenHash: hashSessionToken(token) },
    });
  }

  /** Desactivación / cambio de password: matar todo, opcionalmente menos una. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.db.session.deleteMany({
      where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    });
  }

  /** Barrido diario (maintenance): borra las vencidas abandonadas. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.db.session.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}
