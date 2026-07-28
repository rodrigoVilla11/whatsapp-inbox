import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { SessionAuthMiddleware } from '../auth/session-auth.middleware';
import { MediaModule } from '../media/media.module';
import { TranscriptionController } from './transcription.controller';
import {
  AUDIO_TRANSCRIBER,
  groqTranscriber,
  TranscriptionService,
} from './transcription.service';

@Module({
  imports: [MediaModule], // MEDIA_STORAGE (bajar el audio para transcribir)
  controllers: [TranscriptionController],
  providers: [
    TranscriptionService,
    { provide: AUDIO_TRANSCRIBER, useValue: groqTranscriber },
  ],
})
export class TranscriptionModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionAuthMiddleware).forRoutes(TranscriptionController);
  }
}
