import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  MAINTENANCE_QUEUE,
  ORPHAN_MEDIA_SWEEP_EVERY_MS,
  ORPHAN_MEDIA_SWEEP_JOB,
  PURGE_WEBHOOK_EVENTS_CRON,
  PURGE_WEBHOOK_EVENTS_JOB,
  SESSION_SWEEP_CRON,
  SESSION_SWEEP_JOB,
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
    await this.queue.upsertJobScheduler(
      ORPHAN_MEDIA_SWEEP_JOB,
      { every: ORPHAN_MEDIA_SWEEP_EVERY_MS },
      { name: ORPHAN_MEDIA_SWEEP_JOB },
    );
    await this.queue.upsertJobScheduler(
      SESSION_SWEEP_JOB,
      { pattern: SESSION_SWEEP_CRON },
      { name: SESSION_SWEEP_JOB },
    );
    this.logger.log(
      `Mantenimiento programado: purga WebhookEvent (cron "${PURGE_WEBHOOK_EVENTS_CRON}") ` +
        `+ barrido de media huérfana (cada ${ORPHAN_MEDIA_SWEEP_EVERY_MS / 60000} min) ` +
        `+ barrido de sesiones vencidas (cron "${SESSION_SWEEP_CRON}")`,
    );
  }
}
