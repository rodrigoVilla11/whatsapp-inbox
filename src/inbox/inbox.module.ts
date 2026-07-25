import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware';
import { ConversationsService } from './conversations.service';
import { InboxController } from './inbox.controller';
import { QuickRepliesService } from './quick-replies.service';

@Module({
  imports: [MessagingModule], // GraphApiClient (mark-read best-effort)
  controllers: [InboxController],
  providers: [ConversationsService, QuickRepliesService],
})
export class InboxModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes(InboxController);
  }
}
