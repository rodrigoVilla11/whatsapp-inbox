import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WITH_DELETED } from '../prisma/soft-delete';
import { MEDIA_STORAGE, MediaStorage } from './media-storage';

export interface PurgeContactResult {
  contactId: string;
  conversationsDeleted: number;
  messagesDeleted: number;
  mediaObjectsDeleted: number;
}

/**
 * Retención y borrado.
 *
 * - purgeContact: borrado FÍSICO en cascada (contacto + conversaciones +
 *   mensajes + media en R2). Es el camino para "cliente pide que borren su
 *   conversación". Alcanza también filas soft-deleted.
 * - purgeWebhookEvents: poda PROCESSED/DISCARDED más viejos que la
 *   retención. FAILED se conserva hasta revisión manual.
 *   El wiring como job repeatable de BullMQ se engancha en la fase 3
 *   (cuando exista la infraestructura de colas); el método ya queda listo.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(MEDIA_STORAGE) private readonly mediaStorage: MediaStorage,
  ) {}

  async purgeContact(tenantId: string, contactId: string): Promise<PurgeContactResult> {
    const db = this.prisma.db;

    const { mediaUrls, conversationsDeleted, messagesDeleted } = await db.$transaction(
      async (tx) => {
        // WITH_DELETED: la purga debe alcanzar también lo soft-deleted
        const contact = await tx.contact.findFirst({
          where: { id: contactId, tenantId, ...WITH_DELETED },
          select: { id: true },
        });
        if (!contact) {
          throw new NotFoundException(`Contact ${contactId} no existe para el tenant ${tenantId}`);
        }

        const conversations = await tx.conversation.findMany({
          where: { tenantId, contactId, ...WITH_DELETED },
          select: { id: true },
        });
        const conversationIds = conversations.map((c) => c.id);

        // URLs de media ANTES de borrar las filas que las referencian
        const mediaMessages = await tx.message.findMany({
          where: {
            tenantId,
            conversationId: { in: conversationIds },
            mediaUrl: { not: null },
            ...WITH_DELETED,
          },
          select: { mediaUrl: true },
        });

        const { count: messagesDeleted } = await tx.message.deleteMany({
          where: { tenantId, conversationId: { in: conversationIds } },
        });
        const { count: conversationsDeleted } = await tx.conversation.deleteMany({
          where: { tenantId, contactId },
        });
        await tx.contact.deleteMany({ where: { tenantId, id: contactId } });

        return {
          mediaUrls: mediaMessages.map((m) => m.mediaUrl).filter((u): u is string => u !== null),
          conversationsDeleted,
          messagesDeleted,
        };
      },
    );

    // Fuera de la transacción: si R2 falla, la DB ya quedó consistente y el
    // storage borra best-effort (huérfanos en R2 > fantasmas en la DB).
    await this.mediaStorage.deleteByUrls(mediaUrls);

    this.logger.log(
      `purgeContact tenant=${tenantId} contact=${contactId}: ` +
        `${conversationsDeleted} conversaciones, ${messagesDeleted} mensajes, ${mediaUrls.length} media`,
    );

    return {
      contactId,
      conversationsDeleted,
      messagesDeleted,
      mediaObjectsDeleted: mediaUrls.length,
    };
  }

  async purgeWebhookEvents(retentionDays?: number): Promise<number> {
    const days = retentionDays ?? Number(this.config.get('WEBHOOK_RETENTION_DAYS') ?? 60);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { count } = await this.prisma.db.webhookEvent.deleteMany({
      where: {
        status: { in: ['PROCESSED', 'DISCARDED'] },
        receivedAt: { lt: cutoff },
      },
    });

    this.logger.log(`purgeWebhookEvents: ${count} eventos > ${days} días eliminados`);
    return count;
  }
}
