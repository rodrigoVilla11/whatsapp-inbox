import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getTenantContext } from '../tenant/tenant-context';
import { SendMessageService, SendRequest } from './send-message.service';

/**
 * POST /conversations/:id/messages
 * Body: { clientDedupKey, type: 'text', body }
 *     | { clientDedupKey, type: 'template', templateId, params }
 *
 * Respuesta (siempre el mismo envelope):
 *   { message: Message | null, error: { code, message } | null }
 * - 201 enviado (status PENDING hasta que el webhook confirme SENT)
 * - 200 replay de clientDedupKey (mensaje ya existente, tal cual está)
 * - 422 WINDOW_EXPIRED / TEMPLATE_INVALID / RECIPIENT_UNREACHABLE
 * - 429 RATE_LIMITED · 502 ACCOUNT_ERROR / SEND_FAILED
 */
@Controller('conversations')
export class MessagesController {
  constructor(private readonly sendMessage: SendMessageService) {}

  @Post(':id/messages')
  async send(
    @Param('id') conversationId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: unknown; error: unknown }> {
    const { tenantId, userId } = getTenantContext(req);
    const request = this.validate(body);

    const outcome = await this.sendMessage.send(tenantId, conversationId, request, userId);
    res.status(outcome.httpStatus);
    return { message: outcome.message, error: outcome.error };
  }

  /** Validación manual (sin class-validator a propósito: 4 campos). */
  private validate(body: unknown): SendRequest {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.clientDedupKey !== 'string' || b.clientDedupKey.length < 8 || b.clientDedupKey.length > 128) {
      throw new BadRequestException('clientDedupKey requerido (string de 8 a 128 chars, UUID recomendado)');
    }
    if (b.type === 'text') {
      if (typeof b.body !== 'string' || b.body.trim().length === 0 || b.body.length > 4096) {
        throw new BadRequestException('body requerido para type=text (1 a 4096 chars)');
      }
      return { clientDedupKey: b.clientDedupKey, type: 'text', body: b.body };
    }
    if (b.type === 'template') {
      if (typeof b.templateId !== 'string' || b.templateId.length === 0) {
        throw new BadRequestException('templateId requerido para type=template');
      }
      const params = b.params ?? [];
      if (!Array.isArray(params) || !params.every((p) => typeof p === 'string')) {
        throw new BadRequestException('params debe ser un array de strings');
      }
      return { clientDedupKey: b.clientDedupKey, type: 'template', templateId: b.templateId, params };
    }
    throw new BadRequestException("type debe ser 'text' o 'template'");
  }
}
