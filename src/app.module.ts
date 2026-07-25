import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CryptoModule } from './crypto/crypto.module';
import { EventsModule } from './events/events.module';
import { InboxModule } from './inbox/inbox.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MediaModule } from './media/media.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RetentionModule } from './retention/retention.module';
import { TenantModule } from './tenant/tenant.module';
import { WebhookWorkerModule } from './webhook-worker/webhook-worker.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CryptoModule,
    PrismaModule,
    TenantModule,
    EventsModule,
    QueueModule,
    RetentionModule,
    WebhooksModule,
    WebhookWorkerModule,
    MaintenanceModule,
    MessagingModule,
    MediaModule,
    InboxModule,
  ],
})
export class AppModule {}
