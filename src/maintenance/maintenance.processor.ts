import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MAINTENANCE_QUEUE, PURGE_WEBHOOK_EVENTS_JOB } from '../queue/queue.constants';
import { RetentionService } from '../retention/retention.service';

@Processor(MAINTENANCE_QUEUE, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private readonly retention: RetentionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case PURGE_WEBHOOK_EVENTS_JOB:
        await this.retention.purgeWebhookEvents();
        return;
      default:
        this.logger.warn(`Job de mantenimiento desconocido: ${job.name}`);
    }
  }
}
