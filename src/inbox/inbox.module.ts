import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { SessionAuthMiddleware } from '../auth/session-auth.middleware';
import { GourmetifyModule } from '../gourmetify/gourmetify.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ConversationsService } from './conversations.service';
import { InboxController } from './inbox.controller';
import { QuickRepliesService } from './quick-replies.service';

@Module({
  // MessagingModule: GraphApiClient (mark-read best-effort).
  // GourmetifyModule: lectura de pedidos con sesión.
  imports: [MessagingModule, GourmetifyModule],
  controllers: [InboxController],
  providers: [ConversationsService, QuickRepliesService],
})
export class InboxModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionAuthMiddleware).forRoutes(InboxController);
  }
}
