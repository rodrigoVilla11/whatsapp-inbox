import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WebhooksService } from './webhooks.service';

/**
 * /webhooks/whatsapp        → MetaApp ref "default" (caso Tech Provider)
 * /webhooks/whatsapp/:ref   → MetaApp explícita (caso raro: app propia)
 *
 * El presupuesto del POST es < 1s: resolver app + HMAC + un INSERT + un
 * enqueue. Todo lo demás (parseo, media, Meta) vive en el worker.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get(['whatsapp', 'whatsapp/:ref'])
  async verify(
    @Param('ref') ref: string | undefined,
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const challengeBody = await this.webhooks.verifySubscription(ref, mode, verifyToken, challenge);
    // TEXTO PLANO a mano: la serialización default de Nest devolvería el
    // challenge entre comillas JSON y la verificación de Meta falla sin
    // ningún error obvio.
    res.status(HttpStatus.OK).type('text/plain').send(challengeBody);
  }

  @Post(['whatsapp', 'whatsapp/:ref'])
  @HttpCode(HttpStatus.OK) // Nest devuelve 201 en POST por defecto
  async receive(
    @Param('ref') ref: string | undefined,
    @Headers('x-hub-signature-256') signature: string | string[] | undefined,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<void> {
    // req.rawBody: bytes exactos del wire (ver configureBodyParsers).
    await this.webhooks.receive(ref, req.rawBody, signature);
  }
}
