import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware';
import { GraphApiClient } from '../whatsapp/graph-api.client';
import { MessagesController } from './messages.controller';
import { SendMessageService } from './send-message.service';
import { TemplateSyncService } from './template-sync.service';
import { TemplatesController } from './templates.controller';

@Module({
  controllers: [MessagesController, TemplatesController],
  // TenantContextMiddleware llega del TenantModule global.
  providers: [SendMessageService, TemplateSyncService, GraphApiClient],
  exports: [SendMessageService, GraphApiClient],
})
export class MessagingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // TODO(auth): cuando haya auth real, este middleware pasa a ser el que
    // extrae tenant/usuario de la sesión. Los webhooks NO llevan tenant
    // context: resuelven tenant por phone_number_id del payload.
    consumer.apply(TenantContextMiddleware).forRoutes(MessagesController, TemplatesController);
  }
}
