import { Module } from '@nestjs/common';
import { MEDIA_STORAGE, NoopMediaStorage } from './media-storage';
import { RetentionService } from './retention.service';

@Module({
  providers: [
    RetentionService,
    // Fase 5: reemplazar por la implementación R2 sin tocar RetentionService
    { provide: MEDIA_STORAGE, useClass: NoopMediaStorage },
  ],
  exports: [RetentionService],
})
export class RetentionModule {}
