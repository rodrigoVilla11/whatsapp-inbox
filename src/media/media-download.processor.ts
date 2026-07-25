import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MEDIA_DOWNLOAD_QUEUE, MediaDownloadJob } from '../queue/queue.constants';
import { MediaDownloadService } from './media-download.service';

@Processor(MEDIA_DOWNLOAD_QUEUE, { concurrency: 3 })
export class MediaDownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaDownloadProcessor.name);

  constructor(private readonly service: MediaDownloadService) {
    super();
  }

  async process(job: Job<MediaDownloadJob>): Promise<void> {
    // throw → reintento de BullMQ (3 intentos, backoff exponencial).
    await this.service.download(job.data);
  }

  /** Reintentos agotados → el mensaje queda FAILED (visible para la UI). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<MediaDownloadJob> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      try {
        await this.service.markFailed(job.data, `reintentos agotados: ${error.message}`);
      } catch (markError) {
        this.logger.error(`No se pudo marcar FAILED ${job.data.messageId}: ${String(markError)}`);
      }
    }
  }
}
