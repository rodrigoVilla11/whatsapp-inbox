import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { SessionAuthMiddleware } from '../auth/session-auth.middleware';
import { GraphApiClient } from '../whatsapp/graph-api.client';
import { AutoReplyService } from './auto-reply.service';
import { MessagesController } from './messages.controller';
import { SendMessageService } from './send-message.service';
import { TemplateSyncService } from './template-sync.service';
import { TemplatesController } from './templates.controller';

@Module({
  controllers: [MessagesController, TemplatesController],
  providers: [SendMessageService, TemplateSyncService, GraphApiClient, AutoReplyService],
  exports: [SendMessageService, GraphApiClient, AutoReplyService],
})
export class MessagingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // TODO(auth): cuando haya auth real, este middleware pasa a ser el que
    // extrae tenant/usuario de la sesión. Los webhooks NO llevan tenant
    // context: resuelven tenant por phone_number_id del payload.
    consumer.apply(SessionAuthMiddleware).forRoutes(MessagesController, TemplatesController);
  }
}
