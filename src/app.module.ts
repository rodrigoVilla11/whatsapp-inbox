import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env-validation';
import { CryptoModule } from './crypto/crypto.module';
import { GourmetifyModule } from './gourmetify/gourmetify.module';
import { HealthModule } from './health/health.module';
import { EventsModule } from './events/events.module';
import { InboxModule } from './inbox/inbox.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MediaModule } from './media/media.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { QueueModule } from './queue/queue.module';
import { RetentionModule } from './retention/retention.module';
import { WebhookWorkerModule } from './webhook-worker/webhook-worker.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    // validate: si falta una env crítica, el proceso NO arranca (fase 10)
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    HealthModule,
    CryptoModule,
    PrismaModule,
    AuthModule,
    EventsModule,
    QueueModule,
    RetentionModule,
    WebhooksModule,
    WebhookWorkerModule,
    MaintenanceModule,
    MessagingModule,
    MediaModule,
    InboxModule,
    ProvisioningModule,
    GourmetifyModule,
  ],
})
export class AppModule {}
