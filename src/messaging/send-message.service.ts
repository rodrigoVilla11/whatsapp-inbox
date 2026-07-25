import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Contact, Conversation, Message, WhatsappAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GraphApiClient, GraphApiError } from '../whatsapp/graph-api.client';
import {
  MappedSendError,
  mapMetaSendError,
  mapTransportSendError,
  META_ERROR_RATE_LIMITED,
  META_ERROR_WINDOW_EXPIRED,
  SendErrorCode,
} from './meta-send-errors';
import { renderTemplateBody } from './template.utils';
import { expiredLastInboundAt, isWindowOpen, windowExpiresAt } from './window';

const PREVIEW_MAX_CHARS = 120;

/**
 * La variante 'media' es SOLO server-side: la construye OutboundMediaService
 * después de subir el archivo a R2 y a Meta. El controller HTTP de mensajes
 * únicamente acepta text/template; media entra por POST /conversations/:id/media.
 */
export type SendRequest =
  | { clientDedupKey: string; type: 'text'; body: string }
  | { clientDedupKey: string; type: 'template'; templateId: string; params: string[] }
  | {
      clientDedupKey: string;
      type: 'media';
      messageType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
      /** media_id de Meta (expira ~30 días: se sube por envío, no se reusa). */
      metaMediaId: string;
      /** Key en R2 (el objeto ya está subido). */
      mediaKey: string;
      mediaMimeType: string;
      mediaSizeBytes: number;
      filename: string | null;
      caption: string | null;
      /** Id pre-generado: la key de R2 ya lo contiene ({tenant}/{conv}/{msgId}/...). */
      forcedMessageId: string;
    };

export interface SendOutcome {
  httpStatus: number;
  message: Message | null;
  error: {
    code: SendErrorCode | 'TEMPLATE_INVALID' | 'MEDIA_INVALID' | 'MEDIA_TOO_LARGE';
    message: string;
    windowExpiresAt?: string | null;
  } | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * Envío SÍNCRONO de texto y plantilla (la cajera necesita feedback
 * inmediato; no pasa por cola). Media saliente llega en fase 5.
 *
 * Orden del flujo — cada paso existe por una razón:
 *   1. dedup por (tenantId, clientDedupKey): reintento de red del frontend
 *      → mismo Message, CERO llamadas a Meta.
 *   2. validaciones de dominio (ventana / plantilla) ANTES de persistir.
 *   3. Message PENDING con wamid null ANTES de llamar a Meta: si el proceso
 *      muere a mitad, queda rastro auditable, nunca un envío fantasma.
 *   4. Meta. 130429 → UN reintento con backoff corto, jamás más (el request
 *      no puede colgarse).
 *   5. OK → wamid + conversación; el status queda PENDING hasta que el
 *      webhook de statuses (fase 3) lo confirme como SENT.
 *      Error → FAILED con el error mapeado; 131047 además corrige la
 *      ventana local (Meta gana); 401 marca la cuenta TOKEN_EXPIRED.
 */
@Injectable()
export class SendMessageService {
  private readonly logger = new Logger(SendMessageService.name);
  /** Backoff del único reintento ante 130429. Override en tests. */
  protected rateLimitBackoffMs = 1_500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphApiClient,
  ) {}

  async send(
    tenantId: string,
    conversationId: string,
    request: SendRequest,
    sentByUserId: string | null,
  ): Promise<SendOutcome> {
    const db = this.prisma.db;

    // Conversación + contacto + cuenta, todo scopeado por tenant.
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversación ${conversationId} no existe`);
    }
    const contact = await db.contact.findFirst({
      where: { id: conversation.contactId, tenantId },
    });
    const account = await db.whatsappAccount.findUnique({
      where: { id: conversation.whatsappAccountId },
    });
    if (!contact || !account) {
      throw new NotFoundException('La conversación no tiene contacto o cuenta válidos');
    }

    // 1 ── Idempotencia del frontend: mismo dedupKey → mismo mensaje tal
    // cual está, sin tocar Meta.
    const existing = await db.message.findUnique({
      where: { tenantId_clientDedupKey: { tenantId, clientDedupKey: request.clientDedupKey } },
    });
    if (existing) {
      return { httpStatus: 200, message: existing, error: null };
    }

    // 2 ── Validaciones de dominio, antes de persistir nada.
    const prepared = await this.prepare(tenantId, conversation, contact, request);
    if ('error' in prepared) return prepared.error;

    // 3 ── PENDING antes de llamar a Meta.
    let message: Message;
    try {
      message = await db.message.create({
        data: {
          id: prepared.forcedId ?? undefined,
          tenantId,
          conversationId: conversation.id,
          whatsappAccountId: account.id,
          clientDedupKey: request.clientDedupKey,
          direction: 'OUTBOUND',
          type: prepared.messageType,
          status: 'PENDING',
          wamid: null,
          body: prepared.body,
          templateName: prepared.templateName,
          templateLanguage: prepared.templateLanguage,
          templateParams: prepared.templateParams ?? undefined,
          ...(prepared.mediaFields ?? {}),
          sentByUserId,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Carrera de dos requests con el mismo dedupKey: ganó otro, devolverlo.
        const winner = await db.message.findUnique({
          where: {
            tenantId_clientDedupKey: { tenantId, clientDedupKey: request.clientDedupKey },
          },
        });
        return { httpStatus: 200, message: winner, error: null };
      }
      throw error;
    }

    // 4 ── Meta, con un único reintento ante rate limit.
    // Instante de arranque del intento: si el 131047 llega, el rebobinado
    // de la ventana solo aplica si ningún entrante llegó DESPUÉS de este
    // punto (CAS más abajo) — Meta rechazó contra el estado anterior.
    const attemptStartedAt = new Date();
    let result: { wamid: string | null } | null = null;
    let mapped: MappedSendError | null = null;
    try {
      result = await this.callMetaWithRetry(account, prepared.payload);
    } catch (error) {
      mapped =
        error instanceof GraphApiError
          ? mapMetaSendError(error)
          : mapTransportSendError(error);
    }

    const now = new Date();

    // 5a ── Falla: FAILED + efectos colaterales del error.
    if (mapped) {
      await db.message.updateMany({
        where: { id: message.id, tenantId },
        data: {
          status: 'FAILED',
          failedAt: now,
          errorCode: mapped.metaCode,
          errorTitle: mapped.metaTitle,
          errorDetail: mapped.metaDetail,
        },
      });

      if (mapped.metaCode === META_ERROR_WINDOW_EXPIRED) {
        // Meta dice cerrada → Meta gana: rebobinar lastInboundAt para que
        // isWindowOpen dé false YA y la UI caiga a modo plantilla sin que
        // la cajera reintente a ciegas. Ver expiredLastInboundAt.
        // CAS: solo si ningún entrante llegó después de attemptStartedAt.
        // Si el cliente escribió mientras el envío fallaba, el 131047 es
        // del estado ANTERIOR — gana el dato fresco, no el rebobinado.
        await db.conversation.updateMany({
          where: {
            id: conversation.id,
            tenantId,
            OR: [{ lastInboundAt: null }, { lastInboundAt: { lte: attemptStartedAt } }],
          },
          data: { lastInboundAt: expiredLastInboundAt(now) },
        });
      }
      if (mapped.domainCode === 'ACCOUNT_ERROR') {
        // Señal para el flujo de reconexión futuro.
        await db.whatsappAccount.update({
          where: { id: account.id },
          data: { status: 'TOKEN_EXPIRED', lastErrorCode: mapped.metaCode, lastErrorAt: now },
        });
      }

      const failed = await db.message.findFirst({ where: { id: message.id, tenantId } });
      this.logger.warn(
        `Envío fallido (${mapped.domainCode}) conv=${conversation.id} meta=${mapped.metaCode}`,
      );
      return {
        httpStatus: mapped.httpStatus,
        message: failed,
        error: { code: mapped.domainCode, message: mapped.userMessage },
      };
    }

    // 5b ── OK: wamid + conversación. status sigue PENDING hasta el webhook.
    await db.message.updateMany({
      where: { id: message.id, tenantId },
      data: { wamid: result!.wamid },
    });
    const preview =
      prepared.preview.length > PREVIEW_MAX_CHARS
        ? `${prepared.preview.slice(0, PREVIEW_MAX_CHARS - 1)}…`
        : prepared.preview;
    await db.conversation.updateMany({
      where: {
        id: conversation.id,
        tenantId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: now } }],
      },
      data: { lastMessageAt: now, lastMessagePreview: preview },
    });
    await db.conversation.updateMany({
      where: {
        id: conversation.id,
        tenantId,
        OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lte: now } }],
      },
      data: { lastOutboundAt: now },
    });

    const sent = await db.message.findFirst({ where: { id: message.id, tenantId } });
    return { httpStatus: 201, message: sent, error: null };
  }

  // ─────────────────────────────────────────────────────────────────────

  private windowExpiredOutcome(conversation: Conversation): { error: SendOutcome } {
    return {
      error: {
        httpStatus: 422,
        message: null,
        error: {
          code: 'WINDOW_EXPIRED',
          message:
            'La ventana de 24 horas está cerrada. Usá una plantilla aprobada para contactar al cliente.',
          windowExpiresAt: windowExpiresAt(conversation)?.toISOString() ?? null,
        },
      },
    };
  }

  private async prepare(
    tenantId: string,
    conversation: Conversation,
    contact: Contact,
    request: SendRequest,
  ): Promise<
    | {
        payload: object;
        body: string | null;
        preview: string;
        messageType: 'TEXT' | 'TEMPLATE' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
        templateName: string | null;
        templateLanguage: string | null;
        templateParams: string[] | null;
        mediaFields?: Record<string, unknown>;
        forcedId?: string;
      }
    | { error: SendOutcome }
  > {
    if (request.type === 'text') {
      // El backend es quien rechaza texto libre con ventana cerrada — no se
      // confía en que el frontend lo impida.
      if (!isWindowOpen(conversation)) {
        return this.windowExpiredOutcome(conversation);
      }
      return {
        payload: { to: contact.waId, type: 'text', text: { body: request.body } },
        body: request.body,
        preview: request.body,
        messageType: 'TEXT',
        templateName: null,
        templateLanguage: null,
        templateParams: null,
      };
    }

    if (request.type === 'media') {
      // Media saliente = mensaje de sesión, misma regla que el texto libre:
      // requiere ventana abierta (las plantillas siguen siendo la única
      // alternativa con ventana cerrada).
      if (!isWindowOpen(conversation)) {
        return this.windowExpiredOutcome(conversation);
      }
      const kind = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', DOCUMENT: 'document' }[
        request.messageType
      ];
      const mediaObject: Record<string, unknown> = { id: request.metaMediaId };
      if (request.caption && kind !== 'audio') mediaObject.caption = request.caption;
      if (kind === 'document' && request.filename) mediaObject.filename = request.filename;

      const label = { IMAGE: '📷 Imagen', VIDEO: '🎥 Video', AUDIO: '🎙️ Audio', DOCUMENT: '📄' }[
        request.messageType
      ];
      const preview =
        request.messageType === 'DOCUMENT'
          ? `📄 ${request.filename ?? 'Documento'}`
          : request.caption
            ? `${label.split(' ')[0]} ${request.caption}`
            : label;

      return {
        payload: { to: contact.waId, type: kind, [kind]: mediaObject },
        body: request.caption,
        preview,
        messageType: request.messageType,
        templateName: null,
        templateLanguage: null,
        templateParams: null,
        forcedId: request.forcedMessageId,
        mediaFields: {
          // Ya lo tenemos nosotros en R2: DOWNLOADED desde el inicio.
          mediaId: request.metaMediaId,
          mediaUrl: request.mediaKey,
          mediaMimeType: request.mediaMimeType,
          mediaFilename: request.filename,
          mediaSizeBytes: request.mediaSizeBytes,
          mediaStatus: 'DOWNLOADED',
        },
      };
    }

    // Plantillas: se pueden enviar SIEMPRE, con o sin ventana.
    const template = await this.prisma.db.messageTemplate.findFirst({
      where: {
        id: request.templateId,
        tenantId,
        whatsappAccountId: conversation.whatsappAccountId,
      },
    });
    if (!template) {
      throw new NotFoundException(`Plantilla ${request.templateId} no existe`);
    }
    if (template.status !== 'APPROVED') {
      return {
        error: {
          httpStatus: 422,
          message: null,
          error: {
            code: 'TEMPLATE_INVALID',
            message: `La plantilla "${template.name}" no está aprobada (estado: ${template.status}).`,
          },
        },
      };
    }
    const params = request.params ?? [];
    if (params.length !== template.variableCount) {
      return {
        error: {
          httpStatus: 422,
          message: null,
          error: {
            code: 'TEMPLATE_INVALID',
            message: `La plantilla "${template.name}" espera ${template.variableCount} parámetro(s) y llegaron ${params.length}.`,
          },
        },
      };
    }

    const rendered = renderTemplateBody(template.bodyText, params);
    return {
      payload: {
        to: contact.waId,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          ...(params.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: params.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      },
      body: rendered,
      preview: rendered,
      messageType: 'TEMPLATE',
      templateName: template.name,
      templateLanguage: template.language,
      templateParams: params,
    };
  }

  private async callMetaWithRetry(
    account: WhatsappAccount,
    payload: object,
  ): Promise<{ wamid: string | null }> {
    try {
      return await this.graph.sendMessage(account, payload);
    } catch (error) {
      // UN solo reintento inline y solo ante rate limit: el request de la
      // cajera no puede colgarse 30 segundos.
      if (error instanceof GraphApiError && error.code === META_ERROR_RATE_LIMITED) {
        await new Promise((resolve) => setTimeout(resolve, this.rateLimitBackoffMs));
        return await this.graph.sendMessage(account, payload);
      }
      throw error;
    }
  }
}
