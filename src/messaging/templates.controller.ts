import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getTenantContext } from '../tenant/tenant-context.middleware';
import { TemplateSyncService, TemplateSyncResult } from './template-sync.service';

/**
 * Comando manual de sincronización de plantillas contra Meta.
 * El schedule automático no existe todavía (a propósito).
 */
@Controller('templates')
export class TemplatesController {
  constructor(private readonly sync: TemplateSyncService) {}

  /** POST /templates/sync — body opcional: { whatsappAccountId } */
  @Post('sync')
  async syncTemplates(
    @Body() body: { whatsappAccountId?: string } | undefined,
    @Req() req: Request,
  ): Promise<TemplateSyncResult[]> {
    const { tenantId } = getTenantContext(req);
    if (body?.whatsappAccountId) {
      return [await this.sync.syncAccount(tenantId, body.whatsappAccountId)];
    }
    return this.sync.syncTenant(tenantId);
  }
}
