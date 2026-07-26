import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { MetaAppsService } from './meta-apps.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * EXPLÍCITO (fase 8): /webhooks/* queda FUERA del auth de sesión — acá no
 * hay usuario, hay Meta. Su autenticación es la firma HMAC
 * (x-hub-signature-256) que ya se valida contra el app secret, y el tenant
 * se resuelve por phone_number_id del payload. Este módulo NUNCA aplica
 * SessionAuthMiddleware.
 */
@Module({
  imports: [QueueModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, MetaAppsService],
})
export class WebhooksModule {}
