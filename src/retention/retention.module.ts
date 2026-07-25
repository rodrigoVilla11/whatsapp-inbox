import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { RetentionService } from './retention.service';

@Module({
  // MediaModule exporta MEDIA_STORAGE: la purga borra media real en R2.
  imports: [MediaModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
