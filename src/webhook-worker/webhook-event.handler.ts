import { Injectable, Logger } from '@nestjs/common';
import type { WhatsappAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboundMessagesService } from './inbound-messages.service';
import { MessageStatusesService } from './message-statuses.service';
import type { MetaWebhookPayload } from './meta-webhook.types';

/**
 * Orquestación del procesamiento de un WebhookEvent.
 *
 * Contrato con BullMQ:
 * - Terminar OK (sin throw): evento inexistente, ya PROCESSED/DISCARDED
 *   (idempotencia a nivel job), payload imparseable o tenant irresoluble
 *   (DISCARDED con motivo) — nada de eso se arregla reintentando.
 * - throw: solo errores reales (DB caída, etc.) → BullMQ reintenta con el
 *   backoff configurado. El evento queda en su estado anterior y el
 *   reproceso es seguro porque toda la persistencia de abajo es idempotente.
 */
@Injectable()
export class WebhookEventHandler {
  private readonly logger = new Logger(WebhookEventHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inboundMessages: InboundMessagesService,
    private readonly messageStatuses: MessageStatusesService,
  ) {}

  async handle(webhookEventId: string): Promise<void> {
    const db = this.prisma.db;

    const event = await db.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event) {
      this.logger.warn(`WebhookEvent ${webhookEventId} no existe — job OK sin trabajo`);
      return;
    }
    // Idempotencia a nivel job: un reintento de BullMQ sobre un evento ya
    // terminado no duplica trabajo.
    if (event.status === 'PROCESSED' || event.status === 'DISCARDED') {
      return;
    }

    const payload = event.payload as MetaWebhookPayload | string | null;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) {
      await this.finish(event.id, {
        status: 'DISCARDED',
        error: 'payload sin entry[] parseable',
      });
      return;
    }

    // Un mismo payload puede traer múltiples entries, y cada change trae
    // messages[] y/o statuses[] — se procesa todo.
    let firstAccount: WhatsappAccount | null = null;
    const problems: string[] = [];

    for (const entry of payload.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') {
          this.logger.debug(`Change field "${change.field}" ignorado (no implementado)`);
          continue;
        }
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) {
          problems.push('change sin metadata.phone_number_id');
          continue;
        }

        // Resolución de tenant: phone_number_id → WhatsappAccount → tenantId.
        // (Tabla de plataforma: única lookup legítima sin tenant previo.)
        const account = await db.whatsappAccount.findUnique({ where: { phoneNumberId } });
        if (!account) {
          problems.push(`phone_number_id sin WhatsappAccount: ${phoneNumberId}`);
          continue;
        }
        firstAccount ??= account;

        for (const msg of value?.messages ?? []) {
          await this.inboundMessages.processMessage(account, value!, msg);
        }
        for (const status of value?.statuses ?? []) {
          await this.messageStatuses.apply(account, status);
        }
      }
    }

    if (!firstAccount && problems.length > 0) {
      // Ningún change resolvió tenant: no va a resolver nunca por reintento.
      await this.finish(event.id, { status: 'DISCARDED', error: problems.join('; ') });
      return;
    }

    await this.finish(event.id, {
      status: 'PROCESSED',
      tenantId: firstAccount?.tenantId ?? null,
      whatsappAccountId: firstAccount?.id ?? null,
      phoneNumberId: firstAccount?.phoneNumberId ?? null,
      error: problems.length > 0 ? `parcial: ${problems.join('; ')}` : null,
    });
  }

  private async finish(
    eventId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.db.webhookEvent.update({
      where: { id: eventId },
      data: { ...data, processedAt: new Date() },
    });
  }
}
