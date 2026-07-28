import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { GourmetifyOrdersService, OrderIngestInput } from './orders.service';

/**
 * Webhook de pedidos (Gourmetify → inbox). Auth: x-provisioning-key
 * (ProvisioningAuthMiddleware en el módulo). Idempotente: Gourmetify puede
 * reintentar el mismo pedido/estado sin efectos dobles.
 */
@Controller('gourmetify')
export class GourmetifyOrdersController {
  constructor(private readonly orders: GourmetifyOrdersService) {}

  @Post('orders')
  @HttpCode(200)
  async ingest(@Body() body: OrderIngestInput): Promise<unknown> {
    return this.orders.ingestOrder(body ?? {});
  }
}
