import { Injectable } from '@nestjs/common';
import type { MetaApp } from '@prisma/client';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedMetaApp {
  metaApp: MetaApp;
  /** App secret descifrado — solo vive en memoria, nunca se loguea. */
  appSecret: string;
  /** Verify token descifrado. */
  verifyToken: string;
}

/**
 * Resuelve una MetaApp por su ref público y descifra sus secretos.
 * MetaApp es tabla de plataforma (fuera del tenant guard): el webhook
 * la necesita ANTES de poder saber de qué tenant es el tráfico.
 */
@Injectable()
export class MetaAppsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async resolveByRef(ref: string): Promise<ResolvedMetaApp | null> {
    const metaApp = await this.prisma.db.metaApp.findUnique({ where: { ref } });
    if (!metaApp) return null;
    return {
      metaApp,
      appSecret: this.encryption.decrypt(metaApp.appSecretEnc),
      verifyToken: this.encryption.decrypt(metaApp.verifyTokenEnc),
    };
  }
}
