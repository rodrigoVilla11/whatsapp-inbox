import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { softDeleteExtension } from './soft-delete';
import { tenantGuardExtension } from './tenant-guard';

/**
 * Único punto de acceso a la base. TODO el data access pasa por `db`, que
 * lleva dos extensiones encadenadas:
 *
 *   base → tenantGuard → softDelete
 *
 * Orden de ejecución por query: softDelete corre primero (inyecta el filtro
 * deletedAt), después tenantGuard (valida el scope), después el motor. El
 * redirect findUnique→findFirst de softDelete usa el cliente intermedio,
 * que ya incluye el guard: no hay camino que lo esquive.
 *
 * El PrismaClient crudo es privado a propósito: no exponerlo es lo que hace
 * que "no debe existir un findMany sin scope" sea una propiedad del sistema
 * y no una convención.
 */
function createExtendedClient(base: PrismaClient) {
  return base.$extends(tenantGuardExtension).$extends(softDeleteExtension);
}

export type Db = ReturnType<typeof createExtendedClient>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base = new PrismaClient();

  readonly db: Db = createExtendedClient(this.base);

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
