import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ProcessWebhookEventJob, WEBHOOK_EVENTS_QUEUE } from '../queue/queue.constants';
import { WebhookEventHandler } from './webhook-event.handler';

/**
 * Consumidor de la cola de webhooks. Fino a propósito: toda la lógica vive
 * en WebhookEventHandler (testeable sin Redis).
 *
 * Un throw acá → BullMQ reintenta con el backoff de la cola (5 intentos,
 * exponencial desde 3s). La idempotencia del handler hace seguro cada
 * reintento.
 */
@Processor(WEBHOOK_EVENTS_QUEUE, {
  // Varios eventos en paralelo; los upserts atómicos y las guardas
  // monotónicas del handler toleran concurrencia sobre la misma conversación.
  concurrency: 4,
})
export class WebhookEventsProcessor extends WorkerHost {
  constructor(private readonly handler: WebhookEventHandler) {
    super();
  }

  async process(job: Job<ProcessWebhookEventJob>): Promise<void> {
    await this.handler.handle(job.data.webhookEventId);
  }
}
