export const WEBHOOK_EVENTS_QUEUE = 'webhook-events';

export const PROCESS_WEBHOOK_EVENT_JOB = 'process-webhook-event';

/**
 * El job lleva SOLO el id del WebhookEvent: el payload ya está en Postgres
 * y no se duplica en Redis. El worker lo carga por id.
 */
export interface ProcessWebhookEventJob {
  webhookEventId: string;
}

/** Descarga de media entrante (fase 5). El job es liviano: ids solamente. */
export const MEDIA_DOWNLOAD_QUEUE = 'media-download';

export const MEDIA_DOWNLOAD_JOB = 'download-media';

export interface MediaDownloadJob {
  tenantId: string;
  messageId: string;
}

/** Cola de mantenimiento (jobs programados: purgas, etc.). */
export const MAINTENANCE_QUEUE = 'maintenance';

export const PURGE_WEBHOOK_EVENTS_JOB = 'purge-webhook-events';

/** Cron del job de purga: todos los días a las 04:00 (hora del server). */
export const PURGE_WEBHOOK_EVENTS_CRON = '0 4 * * *';
