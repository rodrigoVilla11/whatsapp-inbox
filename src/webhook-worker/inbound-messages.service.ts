import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, WhatsappAccount } from '@prisma/client';
import { Queue } from 'bullmq';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  MEDIA_DOWNLOAD_JOB,
  MEDIA_DOWNLOAD_QUEUE,
  MediaDownloadJob,
} from '../queue/queue.constants';
import {
  buildMessagePreview,
  mapInboundMessage,
  parseEpochSeconds,
  waIdToE164,
} from './message-mapping';
import type { MetaChangeValue, MetaInboundMessage } from './meta-webhook.types';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * Persistencia de mensajes entrantes. Todo idempotente: Meta reintenta ante
 * cualquier duda y el mismo mensaje llega dos o tres veces.
 *
 * Orden dentro de la transacción — el que hace imposible inflar contadores:
 *   1. upsert Contact            (atómico por unique (tenantId, waId))
 *   2. upsert Conversation       (atómico por unique triple; SIN contadores)
 *   3. create Message            (unique (tenantId, wamid); P2002 → ya
 *      procesado → return SIN tocar nada más)
 *   4. contadores y timestamps   (solo se llega acá si el create creó)
 */
@Injectable()
export class InboundMessagesService {
  private readonly logger = new Logger(InboundMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(MEDIA_DOWNLOAD_QUEUE)
    private readonly mediaQueue: Queue<MediaDownloadJob>,
    @Inject(DOMAIN_EVENT_PUBLISHER)
    private readonly events: DomainEventPublisher,
  ) {}

  async processMessage(
    account: WhatsappAccount,
    value: MetaChangeValue,
    msg: MetaInboundMessage,
  ): Promise<void> {
    const wamid = msg.id;
    const waId = msg.from;
    if (!wamid || !waId) {
      this.logger.warn(`Mensaje entrante sin wamid o sin from — descartado: ${JSON.stringify({ id: wamid, from: waId })}`);
      return;
    }

    const tenantId = account.tenantId;
    const timestamp = parseEpochSeconds(msg.timestamp) ?? new Date();
    const mapped = mapInboundMessage(msg);
    const preview = buildMessagePreview(mapped);
    const profileName =
      value.contacts?.find((c) => c.wa_id === waId)?.profile?.name ?? null;

    const created = await this.prisma.db.$transaction(async (tx) => {
      // 1 ── Contact. Un mensaje nuevo resucita un contacto soft-deleted:
      // si el cliente volvió a escribir, tiene que volver a verse.
      const contact = await tx.contact.upsert({
        where: { tenantId_waId: { tenantId, waId } },
        create: {
          tenantId,
          waId,
          phoneE164: waIdToE164(waId),
          profileName,
        },
        update: {
          deletedAt: null,
          ...(profileName ? { profileName } : {}),
        },
      });

      // 2 ── Conversation: solo asegurar existencia (los contadores van al
      // final, condicionados a que el mensaje sea nuevo).
      const conversation = await tx.conversation.upsert({
        where: {
          tenantId_whatsappAccountId_contactId: {
            tenantId,
            whatsappAccountId: account.id,
            contactId: contact.id,
          },
        },
        create: {
          tenantId,
          whatsappAccountId: account.id,
          contactId: contact.id,
          status: 'OPEN',
        },
        update: { deletedAt: null },
      });

      // 3 ── Message. P2002 = reintento de Meta: no-op silencioso, y lo
      // crítico: NO se ejecuta el paso 4 (unreadCount jamás se infla).
      let createdMessage;
      try {
        createdMessage = await tx.message.create({
          data: {
            tenantId,
            conversationId: conversation.id,
            whatsappAccountId: account.id,
            wamid,
            direction: 'INBOUND',
            type: mapped.type,
            // Para entrantes el ciclo sent/delivered/read no aplica (es
            // nuestro lado el que lo recibe): DELIVERED = "lo tenemos".
            status: 'DELIVERED',
            body: mapped.body,
            replyToWamid: mapped.replyToWamid,
            mediaId: mapped.mediaId,
            mediaMimeType: mapped.mediaMimeType,
            mediaSha256: mapped.mediaSha256,
            mediaFilename: mapped.mediaFilename,
            // La descarga a R2 es fase 5: acá solo queda el registro listo.
            mediaStatus: mapped.hasMedia ? 'PENDING' : null,
            errorCode: mapped.errorCode,
            errorTitle: mapped.errorTitle,
            errorDetail: mapped.errorDetail,
            // Regla de fase 1: raw SOLO para UNSUPPORTED o con error.
            raw: mapped.keepRaw ? (msg as unknown as Prisma.InputJsonValue) : undefined,
            timestamp,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          this.logger.debug(`Mensaje duplicado (reintento de Meta): ${wamid} — no-op`);
          return null;
        }
        throw error;
      }

      // 4 ── Contadores y timestamps, SOLO para mensajes nuevos.
      // Guardas monotónicas con updateMany condicional: dos jobs concurrentes
      // con mensajes fuera de orden no retroceden los timestamps.
      await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          tenantId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: timestamp } }],
        },
        data: { lastMessageAt: timestamp, lastMessagePreview: preview },
      });
      // lastInboundAt: LA ventana de 24h. Toda interacción del cliente la
      // refresca — incluidas reacciones (decisión deliberada: el cliente
      // interactuó; si Meta no lo contara, el 131047 de fase 4 lo cubre).
      await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          tenantId,
          OR: [{ lastInboundAt: null }, { lastInboundAt: { lte: timestamp } }],
        },
        data: { lastInboundAt: timestamp },
      });

      const bump: Record<string, unknown> = {};
      if (!mapped.isReaction) {
        // NUNCA leer-sumar-escribir: increment atómico.
        bump.unreadCount = { increment: 1 };
      }
      if (conversation.status === 'CLOSED') {
        bump.status = 'OPEN'; // mensaje nuevo reabre la conversación
      }
      if (Object.keys(bump).length > 0) {
        await tx.conversation.updateMany({
          where: { id: conversation.id, tenantId },
          data: bump,
        });
      }

      return { message: createdMessage, hasMedia: mapped.hasMedia };
    });

    if (!created) return; // duplicado: nada que encolar ni emitir

    // Encolado de la descarga TRAS el commit, nunca adentro de la tx: si
    // el worker de media corre antes del commit no vería el mensaje, y si
    // la tx rollbackea no debe quedar un job huérfano.
    const messageId = created.message.id as string;
    if (created.hasMedia) {
      await this.mediaQueue.add(
        MEDIA_DOWNLOAD_JOB,
        { tenantId, messageId },
        { jobId: `media-${messageId}` },
      );
    }

    // Eventos también post-commit y por el mismo motivo: un evento de una
    // transacción rollbackeada es una mentira en la pantalla. El publish es
    // best-effort (traga errores adentro) — la fuente de verdad es REST.
    const conversationId = created.message.conversationId as string;
    await this.events.publish({
      tenantId,
      type: 'message.created',
      payload: { conversationId, message: created.message },
    });
    const freshConversation = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (freshConversation) {
      await this.events.publish({
        tenantId,
        type: 'conversation.updated',
        payload: { conversation: freshConversation },
      });
    }
  }
}
