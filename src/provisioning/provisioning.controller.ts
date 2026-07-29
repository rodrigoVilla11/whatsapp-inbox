import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  ProvisioningService,
  TenantProvisionInput,
  WhatsappConnectInput,
} from './provisioning.service';

/**
 * API servicio-a-servicio para Gourmetify (ProvisioningAuthMiddleware:
 * header x-provisioning-key). Contrato en docs/INTEGRACION-GOURMETIFY.md.
 */
@Controller('provisioning')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  /** Diagnóstico: qué tenants hay, cuáles están vinculados y con qué número. */
  @Get('tenants')
  async listTenants(): Promise<unknown[]> {
    return this.provisioning.listTenants();
  }

  /**
   * Alta/actualización idempotente del tenant por gourmetifyTenantId.
   * Con `adoptSlug` vincula un tenant que ya existía en vez de crear uno.
   */
  @Post('tenants')
  async upsertTenant(@Body() body: TenantProvisionInput): Promise<unknown> {
    return this.provisioning.upsertTenant(body ?? {});
  }

  /** Conecta el WhatsApp del cliente (valida contra Meta antes de guardar). */
  @Put('tenants/:gourmetifyTenantId/whatsapp')
  async connectWhatsapp(
    @Param('gourmetifyTenantId') gourmetifyTenantId: string,
    @Body() body: WhatsappConnectInput,
  ): Promise<unknown> {
    return this.provisioning.connectWhatsapp(gourmetifyTenantId, body ?? {});
  }

  /** Estado de la conexión (sin secretos). */
  @Get('tenants/:gourmetifyTenantId/whatsapp')
  async getWhatsapp(
    @Param('gourmetifyTenantId') gourmetifyTenantId: string,
  ): Promise<unknown> {
    return this.provisioning.getWhatsapp(gourmetifyTenantId);
  }
}
