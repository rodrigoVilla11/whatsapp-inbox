import { Injectable, Logger } from '@nestjs/common';
import type { MessageStatus, WhatsappAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseEpochSeconds } from './message-mapping';
import type { MetaPricing, MetaStatus } from './meta-webhook.types';

/**
 * Mapeo de statuses[] de Meta a nuestro Message.
 *
 * AVANCE MONOTÓNICO — el ranking es PENDING < SENT < DELIVERED < READ, con
 * FAILED terminal. Los statuses llegan desordenados (read antes que
 * delivered es normal): un status que rankea más bajo que el actual NO
 * retrocede el campo `status`, pero SÍ sella su timestamp si estaba null.
 *
 * ADVANCE_FROM codifica la regla como dato: cada status de Meta lista desde
 * qué estados propios puede avanzar. El update es un updateMany condicional
 * (`status: { in: ... }`), o sea un compare-and-set atómico en la DB: dos
 * jobs concurrentes aplicando delivered y read no pueden dejar el estado
 * retrocedido, gane quien gane la carrera.
 */
const ADVANCE_FROM: Record<string, { to: MessageStatus; from: MessageStatus[] }> = {
  sent: { to: 'SENT', from: ['PENDING'] },
  delivered: { to: 'DELIVERED', from: ['PENDING', 'SENT'] },
  read: { to: 'READ', from: ['PENDING', 'SENT', 'DELIVERED'] },
};

/** Campo de timestamp que sella cada status (sent no tiene columna propia). */
const SEAL_FIELD: Record<string, 'deliveredAt' | 'readAt'> = {
  delivered: 'deliveredAt',
  read: 'readAt',
};

/**
 * pricing → columnas. SOLO claves presentes: el pricing suele venir en un
 * único status (usualmente sent) y los siguientes no lo traen — un status
 * posterior sin pricing no debe pisar con null lo ya escrito.
 * Strings tal cual los manda Meta, sin enums propios ni transformación.
 */
function pricingToUpdate(pricing: MetaPricing): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (pricing.billable !== undefined) data.billable = pricing.billable;
  if (pricing.pricing_model !== undefined) data.pricingModel = pricing.pricing_model;
  if (pricing.category !== undefined) data.pricingCategory = pricing.category;
  if (pricing.type !== undefined) data.pricingType = pricing.type;
  return data;
}

@Injectable()
export class MessageStatusesService {
  private readonly logger = new Logger(MessageStatusesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async apply(account: WhatsappAccount, status: MetaStatus): Promise<void> {
    const wamid = status.id;
    const metaStatus = status.status;
    if (!wamid || !metaStatus) return;

    const tenantId = account.tenantId;
    const db = this.prisma.db;

    const message = await db.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid } },
    });
    if (!message) {
      // No es error del job: puede ser un mensaje anterior al sistema o ya
      // purgado. Se loguea y se sigue.
      this.logger.warn(`Status "${metaStatus}" para wamid desconocido: ${wamid}`);
      return;
    }

    const ts = parseEpochSeconds(status.timestamp) ?? new Date();

    if (metaStatus === 'failed') {
      // FAILED es terminal: pisa cualquier estado y sella el error.
      const firstError = status.errors?.[0];
      await db.message.updateMany({
        where: { id: message.id, tenantId, status: { not: 'FAILED' } },
        data: {
          status: 'FAILED',
          errorCode: firstError?.code ?? null,
          errorTitle: firstError?.title ?? null,
          errorDetail: firstError?.error_data?.details ?? firstError?.message ?? null,
        },
      });
      await db.message.updateMany({
        where: { id: message.id, tenantId, failedAt: null },
        data: { failedAt: ts },
      });
    } else if (ADVANCE_FROM[metaStatus]) {
      const { to, from } = ADVANCE_FROM[metaStatus];
      // Compare-and-set: solo avanza si el estado actual está en `from`.
      // Un delivered tardío sobre un READ no matchea → no retrocede.
      await db.message.updateMany({
        where: { id: message.id, tenantId, status: { in: from } },
        data: { status: to },
      });

      // El timestamp se sella aunque el avance no haya aplicado (delivered
      // después de read igual deja deliveredAt), solo si estaba null.
      const sealField = SEAL_FIELD[metaStatus];
      if (sealField) {
        await db.message.updateMany({
          where: { id: message.id, tenantId, [sealField]: null },
          data: { [sealField]: ts },
        });
      }
    } else {
      this.logger.warn(`Status desconocido de Meta: "${metaStatus}" (wamid ${wamid})`);
    }

    // Pricing: se escribe cuando aparece, venga en el status que venga.
    if (status.pricing) {
      const pricingData = pricingToUpdate(status.pricing);
      if (Object.keys(pricingData).length > 0) {
        await db.message.updateMany({
          where: { id: message.id, tenantId },
          data: pricingData,
        });
      }
    }

    // Saliente confirmado → lastOutboundAt de la conversación, si el
    // servicio de envío (fase 4) no lo dejó ya más nuevo.
    if (message.direction === 'OUTBOUND' && metaStatus !== 'failed') {
      await db.conversation.updateMany({
        where: {
          id: message.conversationId,
          tenantId,
          OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: message.timestamp } }],
        },
        data: { lastOutboundAt: message.timestamp },
      });
    }
  }
}
