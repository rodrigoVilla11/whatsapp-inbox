import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TenantContext {
  tenantId: string;
  userId: string | null;
}

/**
 * TODO(auth): PROVISORIO hasta montar auth real. Resolución compartida por
 * el middleware REST y el handshake del WebSocket: ambos caminos validan
 * acá, y cuando entre auth real este servicio pasa a resolver desde el
 * token/sesión — los consumidores no cambian.
 *
 * Hoy: tenant del seed (DEFAULT_TENANT_SLUG) + su OWNER como userId.
 */
@Injectable()
export class TenantContextService {
  private cached: TenantContext | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async resolveDefault(): Promise<TenantContext | null> {
    if (this.cached) return this.cached;

    const slug = process.env.DEFAULT_TENANT_SLUG ?? 'nova-sushi';
    const tenant = await this.prisma.db.tenant.findUnique({ where: { slug } });
    if (!tenant) return null;

    const owner = await this.prisma.db.user.findFirst({
      where: { tenantId: tenant.id, role: 'OWNER', isActive: true },
    });
    this.cached = { tenantId: tenant.id, userId: owner?.id ?? null };
    return this.cached;
  }
}
