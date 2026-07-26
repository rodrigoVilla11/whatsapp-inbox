import { Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { HEALTH_REDIS_PING, HealthController, RedisPing } from './health.controller';

/**
 * Conexión Redis dedicada y perezosa para el ping de /health/ready:
 * offline queue apagada — si Redis está caído el ping FALLA rápido en vez
 * de encolarse para siempre.
 */
class HealthRedis implements OnModuleDestroy {
  private client: IORedis | null = null;

  constructor(private readonly url: string) {}

  ping: RedisPing = async () => {
    this.client ??= new IORedis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.client.connect();
    }
    await this.client.ping();
  };

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => this.client?.disconnect());
  }
}

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HealthRedis,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new HealthRedis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6380'),
    },
    {
      provide: HEALTH_REDIS_PING,
      inject: [HealthRedis],
      useFactory: (redis: HealthRedis) => redis.ping,
    },
  ],
})
export class HealthModule {}
