import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MEDIA_STORAGE, MediaStorage } from './media-storage';

export type MediaAccess =
  | { kind: 'redirect'; url: string }
  | { kind: 'conflict'; mediaStatus: string };

const DEFAULT_URL_TTL_SECONDS = 900; // 15 min

/**
 * Servido de media al frontend. Nada de URLs públicas permanentes: es
 * contenido de conversaciones privadas — siempre URL firmada de TTL corto,
 * y siempre scopeado por tenant (el guard hace invisible lo ajeno → 404).
 */
@Injectable()
export class MediaAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  async resolve(tenantId: string, messageId: string): Promise<MediaAccess> {
    const message = await this.prisma.db.message.findFirst({
      where: { id: messageId, tenantId },
    });
    // Mensaje de otro tenant o inexistente: indistinguibles a propósito.
    if (!message || (!message.mediaId && !message.mediaUrl)) {
      throw new NotFoundException(`Mensaje ${messageId} no existe o no tiene media`);
    }
    if (message.mediaStatus !== 'DOWNLOADED' || !message.mediaUrl) {
      // La UI muestra "descargando…" (PENDING) o "no disponible" (FAILED).
      return { kind: 'conflict', mediaStatus: message.mediaStatus ?? 'PENDING' };
    }

    const ttl = Number(this.config.get('MEDIA_URL_TTL_SECONDS') ?? DEFAULT_URL_TTL_SECONDS);
    const url = await this.storage.getPresignedUrl(message.mediaUrl, ttl);
    return { kind: 'redirect', url };
  }
}
