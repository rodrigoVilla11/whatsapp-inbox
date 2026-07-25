import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { MediaDownloadJob } from '../queue/queue.constants';
import { GraphApiClient } from '../whatsapp/graph-api.client';
import { buildMediaKey, defaultFilenameFor } from './media-keys';
import { maxBytesFor, MediaTooLargeError } from './media-limits';
import { MEDIA_STORAGE, MediaStorage } from './media-storage';

export type MediaDownloadOutcome = 'downloaded' | 'skipped' | 'failed-terminal';

/**
 * Descarga de media entrante — SIEMPRE en worker, nunca en el request.
 *
 * Los dos GETs van juntos en el mismo job a propósito: la URL que devuelve
 * GET /{mediaId} expira en minutos, así que cada intento (incluidos los
 * reintentos de BullMQ) pide una URL fresca. Nunca se persiste la URL.
 *
 * Contrato con la cola:
 * - return: terminó (ok, idempotente-skip, o FAILED terminal sin reintento
 *   como tamaño excedido).
 * - throw:  fallo reintetable (URL expirada, red, SHA mismatch) → BullMQ
 *   reintenta con backoff; agotados los intentos, el processor marca
 *   mediaStatus FAILED vía markFailed.
 */
@Injectable()
export class MediaDownloadService {
  private readonly logger = new Logger(MediaDownloadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphApiClient,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(DOMAIN_EVENT_PUBLISHER)
    private readonly events: DomainEventPublisher,
  ) {}

  async download({ tenantId, messageId }: MediaDownloadJob): Promise<MediaDownloadOutcome> {
    const db = this.prisma.db;

    const message = await db.message.findFirst({ where: { id: messageId, tenantId } });
    if (!message) {
      this.logger.warn(`media-download: mensaje ${messageId} no existe — job OK`);
      return 'skipped';
    }
    // Idempotencia: re-ejecución sobre un mensaje ya bajado no re-sube.
    if (message.mediaStatus === 'DOWNLOADED') {
      return 'skipped';
    }
    if (!message.mediaId) {
      await this.markFailed({ tenantId, messageId }, 'mensaje sin mediaId');
      return 'failed-terminal';
    }

    const account = await db.whatsappAccount.findUnique({
      where: { id: message.whatsappAccountId },
    });
    if (!account) {
      await this.markFailed({ tenantId, messageId }, 'cuenta inexistente');
      return 'failed-terminal';
    }

    // 1 ── URL temporal fresca (por intento).
    const info = await this.graph.getMediaInfo(account, message.mediaId);
    if (!info.url) {
      throw new Error(`GET /${message.mediaId} sin url de descarga`); // reintento
    }

    const mimeType = info.mimeType ?? message.mediaMimeType;
    const maxBytes = maxBytesFor(mimeType);

    // Techo ANTES de descargar si Meta ya declaró el tamaño.
    if (info.fileSizeBytes !== null && info.fileSizeBytes > maxBytes) {
      await this.markFailed(
        { tenantId, messageId },
        `tamaño ${info.fileSizeBytes} excede el máximo ${maxBytes}`,
      );
      return 'failed-terminal';
    }

    // 2 ── Descarga del binario (mismo job, URL todavía fresca).
    let buffer: Buffer;
    try {
      buffer = await this.graph.downloadMediaBinary(account, info.url, maxBytes);
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        await this.markFailed(
          { tenantId, messageId },
          `tamaño ${error.actualBytes} excede el máximo ${error.maxBytes}`,
        );
        return 'failed-terminal'; // excedido → FAILED sin reintento
      }
      throw error; // URL expirada / red → reintento con URL fresca
    }

    // 3 ── Integridad: SHA-256 contra lo declarado (webhook o media info).
    const expectedSha = message.mediaSha256 ?? info.sha256;
    if (expectedSha) {
      const digest = createHash('sha256').update(buffer).digest();
      // Meta lo expresa a veces en hex y a veces en base64: se acepta
      // cualquiera de las dos representaciones del MISMO hash.
      const matches = expectedSha === digest.toString('hex') || expectedSha === digest.toString('base64');
      if (!matches) {
        throw new Error(`SHA-256 no coincide para ${messageId}`); // fallo de descarga → reintento
      }
    }

    // 4 ── Subida a R2 y cierre. En mediaUrl va la KEY (las URLs se firman
    // al servir).
    const filename = message.mediaFilename ?? defaultFilenameFor(mimeType);
    const key = buildMediaKey(tenantId, message.conversationId, message.id, filename);
    await this.storage.put(key, buffer, mimeType ?? 'application/octet-stream');

    await db.message.updateMany({
      where: { id: message.id, tenantId },
      data: {
        mediaUrl: key,
        mediaSizeBytes: buffer.length,
        mediaMimeType: mimeType,
        mediaStatus: 'DOWNLOADED',
      },
    });
    this.logger.log(`media-download OK: ${key} (${buffer.length} bytes)`);

    // La UI puede pasar de "descargando…" al media real.
    await this.events.publish({
      tenantId,
      type: 'message.updated',
      payload: {
        id: message.id,
        conversationId: message.conversationId,
        changes: {
          mediaStatus: 'DOWNLOADED',
          mediaMimeType: mimeType,
          mediaSizeBytes: buffer.length,
        },
      },
    });
    return 'downloaded';
  }

  /** Marca FAILED sin pisar un DOWNLOADED previo; el motivo va al log y a errorDetail si estaba libre. */
  async markFailed({ tenantId, messageId }: MediaDownloadJob, reason: string): Promise<void> {
    this.logger.warn(`media-download FAILED ${messageId}: ${reason}`);
    const db = this.prisma.db;
    await db.message.updateMany({
      where: { id: messageId, tenantId, mediaStatus: { not: 'DOWNLOADED' } },
      data: { mediaStatus: 'FAILED' },
    });
    await db.message.updateMany({
      where: { id: messageId, tenantId, errorDetail: null },
      data: { errorDetail: `media: ${reason}` },
    });

    const failed = await db.message.findFirst({ where: { id: messageId, tenantId } });
    if (failed?.mediaStatus === 'FAILED') {
      await this.events.publish({
        tenantId,
        type: 'message.updated',
        payload: {
          id: failed.id,
          conversationId: failed.conversationId,
          changes: { mediaStatus: 'FAILED' },
        },
      });
    }
  }
}
