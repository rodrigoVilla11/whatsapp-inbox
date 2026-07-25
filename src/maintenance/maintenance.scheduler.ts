import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  MAINTENANCE_QUEUE,
  PURGE_WEBHOOK_EVENTS_CRON,
  PURGE_WEBHOOK_EVENTS_JOB,
} from '../queue/queue.constants';

/**
 * Registra el job repeatable de purga de WebhookEvent (pendiente de fase 1).
 *
 * Sin doble ejecución con N instancias de la app:
 * - upsertJobScheduler es idempotente por schedulerId: aunque cada réplica
 *   lo registre al bootear, existe UN solo schedule en Redis.
 * - BullMQ entrega cada job a UN solo worker (lock interno con token y
 *   renovación): dos instancias jamás procesan la misma corrida en paralelo.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceScheduler.name);

  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PURGE_WEBHOOK_EVENTS_JOB,
      { pattern: PURGE_WEBHOOK_EVENTS_CRON },
      { name: PURGE_WEBHOOK_EVENTS_JOB },
    );
    this.logger.log(
      `Purga de WebhookEvent programada (cron "${PURGE_WEBHOOK_EVENTS_CRON}")`,
    );
  }
}
