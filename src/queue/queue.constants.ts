export const WEBHOOK_EVENTS_QUEUE = 'webhook-events';

export const PROCESS_WEBHOOK_EVENT_JOB = 'process-webhook-event';

/**
 * El job lleva SOLO el id del WebhookEvent: el payload ya está en Postgres
 * y no se duplica en Redis. El worker (fase 3) lo carga por id.
 */
export interface ProcessWebhookEventJob {
  webhookEventId: string;
}
