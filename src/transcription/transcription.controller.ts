import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getTenantContext } from '../tenant/tenant-context';
import { TranscriptionService } from './transcription.service';

/** Transcripción bajo demanda — sesión obligatoria, cualquier rol. */
@Controller('messages')
export class TranscriptionController {
  constructor(private readonly transcription: TranscriptionService) {}

  @Post(':id/transcribe')
  @HttpCode(200)
  async transcribe(@Param('id') messageId: string, @Req() req: Request): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.transcription.transcribeMessage(tenantId, messageId);
  }
}
