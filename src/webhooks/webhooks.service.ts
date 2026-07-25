import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  PROCESS_WEBHOOK_EVENT_JOB,
  ProcessWebhookEventJob,
  WEBHOOK_EVENTS_QUEUE,
} from '../queue/queue.constants';
import { MetaAppsService } from './meta-apps.service';
import { timingSafeStringEqual, verifyMetaSignature } from './webhook-signature';
import { DEFAULT_META_APP_REF } from './webhooks.constants';

/** Techo para payloads NO autenticados (ref desconocido) que se auditan. */
const UNAUTHENTICATED_PAYLOAD_MAX_CHARS = 10_000;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly metaApps: MetaAppsService,
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_EVENTS_QUEUE)
    private readonly queue: Queue<ProcessWebhookEventJob>,
  ) {}

  /**
   * GET de verificación de Meta. Devuelve el challenge a responder EN TEXTO
   * PLANO. El verify token se compara contra el descifrado de la MetaApp
   * resuelta por ref — nunca contra env.
   */
  async verifySubscription(
    refParam: string | undefined,
    mode: string | undefined,
    verifyToken: string | undefined,
    challenge: string | undefined,
  ): Promise<string> {
    const ref = refParam ?? DEFAULT_META_APP_REF;
    const resolved = await this.metaApps.resolveByRef(ref);
    if (!resolved) {
      throw new NotFoundException(`MetaApp ref desconocido: ${ref}`);
    }
    if (
      mode !== 'subscribe' ||
      typeof verifyToken !== 'string' ||
      !timingSafeStringEqual(verifyToken, resolved.verifyToken)
    ) {
      throw new ForbiddenException('Verificación de webhook rechazada');
    }
    return challenge ?? '';
  }

  /**
   * POST del webhook. Contrato de respuesta:
   * - ref desconocido        → 200 (un 404 repetido hace que Meta marque el
   *                            endpoint como caído) + WebhookEvent DISCARDED.
   * - firma ausente/inválida → 401, sin persistir ni encolar.
   * - firma válida           → persistir RECEIVED, encolar SOLO el id,
   *                            marcar QUEUED, 200. Cero parseo de mensajes,
   *                            cero llamadas a Meta.
   * - error interno post-firma → loguear, FAILED si se puede, 200 IGUAL
   *                            (un 500 dispara reintentos infinitos).
   */
  async receive(
    refParam: string | undefined,
    rawBody: Buffer | undefined,
    signatureHeader: string | string[] | undefined,
  ): Promise<void> {
    const ref = refParam ?? DEFAULT_META_APP_REF;
    const resolved = await this.metaApps.resolveByRef(ref);

    if (!resolved) {
      this.logger.warn(`POST de webhook con ref desconocido "${ref}": descartado con 200`);
      await this.persistDiscardedSafe(ref, rawBody);
      return;
    }

    if (!verifyMetaSignature(rawBody, resolved.appSecret, signatureHeader)) {
      // Antes de persistir nada: payloads que no autentican no entran a la DB.
      throw new UnauthorizedException('X-Hub-Signature-256 inválida');
    }

    // ── Firma válida: de acá en adelante la respuesta es 200, pase lo que pase ──
    let eventId: string | undefined;
    try {
      const event = await this.prisma.db.webhookEvent.create({
        data: {
          metaAppId: resolved.metaApp.id,
          signatureValid: true,
          status: 'RECEIVED',
          // tenantId/whatsappAccountId/phoneNumberId los resuelve el worker
          // (fase 3): acá cero parseo del contenido.
          payload: this.toStoredPayload(rawBody!),
        },
      });
      eventId = event.id;

      await this.queue.add(
        PROCESS_WEBHOOK_EVENT_JOB,
        { webhookEventId: event.id },
        { jobId: event.id },
      );
      await this.prisma.db.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'QUEUED' },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error interno post-firma (evento ${eventId ?? 'sin persistir'}): ${detail}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (eventId) {
        try {
          await this.prisma.db.webhookEvent.update({
            where: { id: eventId },
            data: { status: 'FAILED', error: detail },
          });
        } catch (updateError) {
          this.logger.error(
            `No se pudo marcar FAILED el evento ${eventId}: ${String(updateError)}`,
          );
        }
      }
      // Swallow: la respuesta sigue siendo 200.
    }
  }

  /**
   * El payload se guarda parseado si es JSON válido; si no, como string
   * crudo (firma válida + JSON roto no puede tirar el handler: se audita
   * y el worker decidirá qué hacer).
   */
  private toStoredPayload(rawBody: Buffer): Prisma.InputJsonValue {
    const text = rawBody.toString('utf8');
    try {
      return JSON.parse(text) as Prisma.InputJsonValue;
    } catch {
      return text;
    }
  }

  private async persistDiscardedSafe(ref: string, rawBody: Buffer | undefined): Promise<void> {
    try {
      // No autenticado: se guarda como string truncado, sin parsear.
      const text = (rawBody ?? Buffer.alloc(0))
        .toString('utf8')
        .slice(0, UNAUTHENTICATED_PAYLOAD_MAX_CHARS);
      await this.prisma.db.webhookEvent.create({
        data: {
          signatureValid: false,
          status: 'DISCARDED',
          error: `MetaApp ref desconocido: ${ref}`,
          payload: text,
        },
      });
    } catch (error) {
      // Ni siquiera esto puede convertir la respuesta en un no-200.
      this.logger.error(`No se pudo auditar el POST descartado (ref=${ref}): ${String(error)}`);
    }
  }
}
