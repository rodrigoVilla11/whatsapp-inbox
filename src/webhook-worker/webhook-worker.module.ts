import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { QueueModule } from '../queue/queue.module';
import { InboundMessagesService } from './inbound-messages.service';
import { MessageStatusesService } from './message-statuses.service';
import { WebhookEventHandler } from './webhook-event.handler';
import { WebhookEventsProcessor } from './webhook-events.processor';

@Module({
  imports: [QueueModule, MessagingModule], // AutoReplyService (fuera de horario)
  providers: [
    WebhookEventsProcessor,
    WebhookEventHandler,
    InboundMessagesService,
    MessageStatusesService,
  ],
  exports: [WebhookEventHandler],
})
export class WebhookWorkerModule {}
