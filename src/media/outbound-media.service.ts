import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageService, SendOutcome } from '../messaging/send-message.service';
import { isWindowOpen, windowExpiresAt } from '../messaging/window';
import { GraphApiClient } from '../whatsapp/graph-api.client';
import { magicBytesMatch } from './magic-bytes';
import { buildMediaKey } from './media-keys';
import { maxBytesFor, OUTBOUND_MEDIA_TYPES } from './media-limits';
import { MEDIA_STORAGE, MediaStorage } from './media-storage';

export interface OutboundMediaInput {
  clientDedupKey: string;
  buffer: Buffer;
  declaredMime: string;
  filename: string;
  caption: string | null;
}

/**
 * Media saliente: la UI sube el archivo acá; nosotros lo subimos a R2 (key
 * con el messageId pre-generado) y a Meta (media_id efímero), y el envío
 * del mensaje va por SendMessageService con el media_id — mismo dedup,
 * misma ventana, mismo mapeo de errores que texto.
 *
 * Orden anti-desperdicio: dedup y validaciones (ventana, allowlist, magic
 * bytes, techo) ANTES de subir nada a R2/Meta.
 */
@Injectable()
export class OutboundMediaService {
  private readonly logger = new Logger(OutboundMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphApiClient,
    private readonly sendMessage: SendMessageService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  async sendMedia(
    tenantId: string,
    conversationId: string,
    input: OutboundMediaInput,
    sentByUserId: string | null,
  ): Promise<SendOutcome> {
    const db = this.prisma.db;

    // Dedup ANTES de subir nada: un replay no debe re-subir a R2/Meta.
    const existing = await db.message.findUnique({
      where: { tenantId_clientDedupKey: { tenantId, clientDedupKey: input.clientDedupKey } },
    });
    if (existing) {
      return { httpStatus: 200, message: existing, error: null };
    }

    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversación ${conversationId} no existe`);
    }
    const account = await db.whatsappAccount.findUnique({
      where: { id: conversation.whatsappAccountId },
    });
    if (!account) {
      throw new NotFoundException('La conversación no tiene cuenta válida');
    }

    // Ventana ANTES de subir (la autoridad final sigue siendo prepare()).
    if (!isWindowOpen(conversation)) {
      return {
        httpStatus: 422,
        message: null,
        error: {
          code: 'WINDOW_EXPIRED',
          message:
            'La ventana de 24 horas está cerrada. Usá una plantilla aprobada para contactar al cliente.',
          windowExpiresAt: windowExpiresAt(conversation)?.toISOString() ?? null,
        },
      };
    }

    const mime = input.declaredMime.split(';')[0].trim().toLowerCase();
    const allowed = OUTBOUND_MEDIA_TYPES[mime];
    if (!allowed) {
      return {
        httpStatus: 422,
        message: null,
        error: {
          code: 'MEDIA_INVALID',
          message: `Tipo de archivo no soportado por WhatsApp: ${mime}`,
        },
      };
    }
    // El content-type declarado es del cliente: verificar contra los bytes.
    if (!magicBytesMatch(mime, input.buffer)) {
      return {
        httpStatus: 422,
        message: null,
        error: {
          code: 'MEDIA_INVALID',
          message: `El contenido del archivo no coincide con el tipo declarado (${mime})`,
        },
      };
    }
    const maxBytes = maxBytesFor(mime);
    if (input.buffer.length > maxBytes) {
      return {
        httpStatus: 413,
        message: null,
        error: {
          code: 'MEDIA_TOO_LARGE',
          message: `El archivo supera el máximo de ${Math.floor(maxBytes / (1024 * 1024))}MB para este tipo`,
        },
      };
    }

    // Id pre-generado: la key de R2 lleva el messageId real del Message
    // que se crea después ({tenant}/{conv}/{msgId}/{filename}).
    const messageId = randomUUID();
    const key = buildMediaKey(tenantId, conversation.id, messageId, input.filename);

    await this.storage.put(key, input.buffer, mime);
    const metaMediaId = await this.graph.uploadMedia(
      account,
      input.buffer,
      mime,
      input.filename,
    );

    const outcome = await this.sendMessage.send(
      tenantId,
      conversationId,
      {
        clientDedupKey: input.clientDedupKey,
        type: 'media',
        messageType: allowed.kind,
        metaMediaId,
        mediaKey: key,
        mediaMimeType: mime,
        mediaSizeBytes: input.buffer.length,
        filename: allowed.kind === 'DOCUMENT' ? input.filename : null,
        caption: input.caption,
        forcedMessageId: messageId,
      },
      sentByUserId,
    );

    if (outcome.error) {
      // El objeto queda en R2 (el purge lo limpia con el contacto); solo log.
      this.logger.warn(
        `Media subida pero envío falló (${outcome.error.code}): key=${key} meta=${metaMediaId}`,
      );
    }
    return outcome;
  }
}
