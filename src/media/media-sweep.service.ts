import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  MEDIA_DOWNLOAD_JOB,
  MEDIA_DOWNLOAD_QUEUE,
  MediaDownloadJob,
  ORPHAN_MEDIA_MIN_AGE_MS,
} from '../queue/queue.constants';

/**
 * Rescate de media huérfana. El encolado post-commit (correcto para no
 * crear jobs de transacciones rollbackeadas) deja UN caso recuperable:
 * proceso muerto entre el commit y el queue.add, o el evento failed del
 * worker perdido → mensaje PENDING sin job, para siempre.
 *
 * Este barrido re-encola los PENDING viejos. El job de descarga es
 * idempotente, así que un falso positivo no duplica nada. jobId distinto
 * del original (`media-sweep-...`): si el job original quedó FAILED en
 * Redis, el mismo jobId sería deduplicado y el rescate no ocurriría.
 *
 * Itera por tenant a propósito: el tenant guard exige tenantId en toda
 * query del dominio, y el barrido no es la excepción.
 */
@Injectable()
export class MediaSweepService {
  private readonly logger = new Logger(MediaSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(MEDIA_DOWNLOAD_QUEUE)
    private readonly mediaQueue: Queue<MediaDownloadJob>,
  ) {}

  async rescueOrphans(minAgeMs: number = ORPHAN_MEDIA_MIN_AGE_MS): Promise<number> {
    const db = this.prisma.db;
    const cutoff = new Date(Date.now() - minAgeMs);
    let rescued = 0;

    const tenants = await db.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      const orphans = await db.message.findMany({
        where: {
          tenantId: tenant.id,
          mediaStatus: 'PENDING',
          createdAt: { lt: cutoff },
        },
        select: { id: true },
      });
      for (const orphan of orphans) {
        await this.mediaQueue.add(
          MEDIA_DOWNLOAD_JOB,
          { tenantId: tenant.id, messageId: orphan.id },
          { jobId: `media-sweep-${orphan.id}` },
        );
        rescued += 1;
      }
    }

    if (rescued > 0) {
      this.logger.warn(`Barrido de media huérfana: ${rescued} mensaje(s) re-encolado(s)`);
    }
    return rescued;
  }
}
