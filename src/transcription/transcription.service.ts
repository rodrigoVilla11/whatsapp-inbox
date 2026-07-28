import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Message } from '@prisma/client';
import { serializeMessage } from '../common/serializers';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../events/domain-events';
import { MEDIA_STORAGE, MediaStorage } from '../media/media-storage';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Transcripción de audios BAJO DEMANDA (Whisper large-v3 vía Groq):
 * la cajera toca "Transcribir" en el audio y lee en vez de escuchar.
 * Cache dura: se transcribe (y paga) UNA vez por mensaje — el resultado
 * queda en Message.transcription y viaja por message.updated a todas las
 * pantallas abiertas.
 *
 * Sin GROQ_API_KEY la feature está apagada: /auth/me lo anuncia
 * (features.transcription=false) y este endpoint responde 503 claro.
 */

export const AUDIO_TRANSCRIBER = Symbol('AUDIO_TRANSCRIBER');

export type AudioTranscriber = (
  audio: { buffer: Buffer; mimeType: string; filename: string },
) => Promise<string>;

export function transcriptionEnabled(): boolean {
  return !!process.env.GROQ_API_KEY?.trim();
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3';
const GROQ_TIMEOUT_MS = 30_000;

/** Implementación real contra Groq (API compatible OpenAI). */
export const groqTranscriber: AudioTranscriber = async (audio) => {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY ausente');

  const form = new FormData();
  form.append('model', GROQ_MODEL);
  form.append('language', process.env.TRANSCRIPTION_LANGUAGE?.trim() || 'es');
  form.append('response_format', 'json');
  form.append(
    'file',
    new Blob([new Uint8Array(audio.buffer)], { type: audio.mimeType }),
    audio.filename,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      text?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(body.error?.message ?? `Groq respondió ${res.status}`);
    }
    return (body.text ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
};

const SIGNED_URL_TTL_SECONDS = 120; // solo para que ESTE server baje el audio

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
    @Inject(AUDIO_TRANSCRIBER) private readonly transcribe: AudioTranscriber,
  ) {}

  async transcribeMessage(tenantId: string, messageId: string): Promise<unknown> {
    if (!transcriptionEnabled()) {
      throw new ServiceUnavailableException(
        'La transcripción no está configurada (falta GROQ_API_KEY)',
      );
    }
    const db = this.prisma.db;
    const message = (await db.message.findFirst({
      where: { id: messageId, tenantId },
    })) as Message | null;
    // Ajeno o inexistente: indistinguibles, como toda la media.
    if (!message) throw new NotFoundException(`Mensaje ${messageId} no existe`);

    // Cache: ya transcripto → devolver sin tocar Groq (se paga una vez).
    if (message.transcription) {
      return { message: serializeMessage(message), cached: true };
    }

    if (message.type !== 'AUDIO') {
      throw new BadRequestException('Solo se transcriben audios');
    }
    if (message.mediaStatus !== 'DOWNLOADED' || !message.mediaUrl) {
      throw new BadRequestException(
        'El audio todavía no está disponible — esperá a que termine de descargarse',
      );
    }

    // Bajar el audio del storage (URL firmada de TTL corto, uso interno).
    const url = await this.storage.getPresignedUrl(message.mediaUrl, SIGNED_URL_TTL_SECONDS);
    const audioRes = await fetch(url);
    if (!audioRes.ok) {
      throw new ServiceUnavailableException('No se pudo leer el audio del storage');
    }
    const buffer = Buffer.from(await audioRes.arrayBuffer());

    let text: string;
    try {
      text = await this.transcribe({
        buffer,
        mimeType: message.mediaMimeType ?? 'audio/ogg',
        filename: message.mediaFilename ?? 'audio.ogg',
      });
    } catch (error) {
      // No se persiste nada: el botón queda disponible para reintentar.
      this.logger.warn(`Transcripción falló (${messageId}): ${String(error)}`);
      throw new HttpException(
        `No se pudo transcribir: ${error instanceof Error ? error.message : 'error del servicio'}`,
        502,
      );
    }

    const transcription = text || '(audio sin voz detectable)';
    await db.message.updateMany({
      where: { id: message.id, tenantId },
      data: { transcription },
    });

    // Tiempo real: todas las pantallas abiertas la ven aparecer.
    await this.events.publish({
      tenantId,
      type: 'message.updated',
      payload: { id: message.id, conversationId: message.conversationId, changes: { transcription } },
    });

    return {
      message: serializeMessage({ ...message, transcription } as Message),
      cached: false,
    };
  }
}
