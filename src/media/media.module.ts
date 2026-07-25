import { Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagingModule } from '../messaging/messaging.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware';
import { MediaAccessService } from './media-access.service';
import { MediaController } from './media.controller';
import { MediaDownloadProcessor } from './media-download.processor';
import { MediaDownloadService } from './media-download.service';
import { MEDIA_STORAGE, NoopMediaStorage } from './media-storage';
import { OutboundMediaService } from './outbound-media.service';
import { R2MediaStorage } from './r2-media-storage';

@Module({
  imports: [QueueModule, MessagingModule],
  controllers: [MediaController],
  providers: [
    MediaDownloadService,
    MediaDownloadProcessor,
    MediaAccessService,
    OutboundMediaService,
    {
      // R2 con credenciales configuradas; sin R2_* (dev pelado) cae al noop
      // con warning — el server bootea igual, la media queda inerte.
      provide: MEDIA_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const endpoint = config.get<string>('R2_ENDPOINT');
        const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
        const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
        const bucket = config.get<string>('R2_BUCKET');
        if (endpoint && accessKeyId && secretAccessKey && bucket) {
          return new R2MediaStorage({ endpoint, accessKeyId, secretAccessKey, bucket });
        }
        new Logger('MediaModule').warn(
          'R2_* incompletas en env: storage de media en modo noop (solo dev)',
        );
        return new NoopMediaStorage();
      },
    },
  ],
  exports: [MEDIA_STORAGE],
})
export class MediaModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes(MediaController);
  }
}
