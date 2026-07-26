import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { getTenantContext } from '../tenant/tenant-context';
import { absoluteMaxBytes } from './media-limits';
import { MediaAccessService } from './media-access.service';
import { OutboundMediaService } from './outbound-media.service';

@Controller()
export class MediaController {
  constructor(
    private readonly access: MediaAccessService,
    private readonly outbound: OutboundMediaService,
  ) {}

  /**
   * GET /messages/:id/media
   * - 302 → URL firmada de R2 (TTL corto) si está DOWNLOADED
   * - 409 { mediaStatus } si PENDING/FAILED ("descargando…" / "no disponible")
   * - 404 si no existe, no tiene media, o es de otro tenant (indistinguible)
   */
  @Get('messages/:id/media')
  async serve(
    @Param('id') messageId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { tenantId } = getTenantContext(req);
    const result = await this.access.resolve(tenantId, messageId);
    if (result.kind === 'conflict') {
      res.status(HttpStatus.CONFLICT).json({ mediaStatus: result.mediaStatus });
      return;
    }
    res.redirect(HttpStatus.FOUND, result.url);
  }

  /**
   * POST /conversations/:id/media — multipart:
   *   file (binario) + clientDedupKey + caption?
   * Mismo envelope { message, error } y mismos códigos que el envío de texto
   * (+ MEDIA_INVALID / MEDIA_TOO_LARGE).
   */
  @Post('conversations/:id/media')
  @UseInterceptors(
    // Techo absoluto acá (multer corta el stream); el techo fino por tipo
    // se valida después en OutboundMediaService.
    FileInterceptor('file', { limits: { fileSize: absoluteMaxBytes() } }),
  )
  async upload(
    @Param('id') conversationId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { clientDedupKey?: string; caption?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: unknown; error: unknown }> {
    const { tenantId, userId } = getTenantContext(req);

    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException("Falta el archivo (campo multipart 'file')");
    }
    const clientDedupKey = body.clientDedupKey;
    if (typeof clientDedupKey !== 'string' || clientDedupKey.length < 8 || clientDedupKey.length > 128) {
      throw new BadRequestException('clientDedupKey requerido (string de 8 a 128 chars)');
    }
    const caption = typeof body.caption === 'string' && body.caption.trim() ? body.caption : null;

    const outcome = await this.outbound.sendMedia(
      tenantId,
      conversationId,
      {
        clientDedupKey,
        buffer: file.buffer,
        declaredMime: file.mimetype ?? 'application/octet-stream',
        filename: file.originalname || 'archivo',
        caption,
      },
      userId,
    );
    res.status(outcome.httpStatus);
    return { message: outcome.message, error: outcome.error };
  }
}
