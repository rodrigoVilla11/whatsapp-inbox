import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CryptoModule } from './crypto/crypto.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RetentionModule } from './retention/retention.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CryptoModule,
    PrismaModule,
    QueueModule,
    RetentionModule,
    WebhooksModule,
  ],
})
export class AppModule {}
