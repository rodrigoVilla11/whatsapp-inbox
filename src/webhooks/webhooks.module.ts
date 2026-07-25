import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { MetaAppsService } from './meta-apps.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [QueueModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, MetaAppsService],
})
export class WebhooksModule {}
