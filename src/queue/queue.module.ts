import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MEDIA_DOWNLOAD_QUEUE, WEBHOOK_EVENTS_QUEUE } from './queue.constants';
import { redisConnectionFromUrl } from './redis-connection';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionFromUrl(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6380',
        ),
      }),
    }),
    BullModule.registerQueue({
      name: WEBHOOK_EVENTS_QUEUE,
      defaultJobOptions: {
        // Meta reintenta ante cualquier no-200; nosotros reintentamos el
        // procesamiento interno: 5 intentos con backoff exponencial
        // (3s, 6s, 12s, 24s, 48s) antes de dar el job por fallado.
        attempts: 5,
        backoff: { type: 'exponential', delay: 3_000 },
        // Redis no crece sin techo: los completados se limpian por edad y
        // cantidad; los fallados se conservan una semana para diagnóstico
        // (el payload real siempre está en Postgres, acá solo viven ids).
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
    BullModule.registerQueue({
      name: MEDIA_DOWNLOAD_QUEUE,
      defaultJobOptions: {
        // La URL de descarga de Meta expira en minutos: cada reintento pide
        // una fresca (paso 1 del job), así que el backoff puede ser corto.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
