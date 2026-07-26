import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MinRole, RolesGuard } from '../auth/roles';
import { getTenantContext } from '../tenant/tenant-context';
import { TemplateSyncService, TemplateSyncResult } from './template-sync.service';

/**
 * Comando manual de sincronización de plantillas contra Meta.
 * El schedule automático no existe todavía (a propósito).
 */
@Controller('templates')
@UseGuards(RolesGuard)
export class TemplatesController {
  constructor(private readonly sync: TemplateSyncService) {}

  /** POST /templates/sync — body opcional: { whatsappAccountId } */
  @Post('sync')
  @MinRole('ADMIN')
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
