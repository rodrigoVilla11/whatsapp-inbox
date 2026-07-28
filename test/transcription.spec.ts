/**
 * Transcripción de audios bajo demanda: feature flag por env, cache dura
 * (una sola llamada al proveedor por mensaje), validaciones y evento
 * message.updated para el tiempo real.
 */
import 'reflect-metadata';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { TranscriptionService } from '../src/transcription/transcription.service';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';

let db: FakeDb;
let service: TranscriptionService;
let transcriber: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let storage: { getPresignedUrl: ReturnType<typeof vi.fn> };

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  process.env.GROQ_API_KEY = 'gsk_test';
  db = createFakeDb();
  transcriber = vi.fn().mockResolvedValue('hola quiero dos rolls');
  publish = vi.fn().mockResolvedValue(undefined);
  storage = { getPresignedUrl: vi.fn().mockResolvedValue('https://r2.example/firmada') };
  service = new TranscriptionService(
    { db } as unknown as PrismaService,
    storage as never,
    { publish } as never,
    (audio) => transcriber(audio),
  );

  // el service baja el audio con fetch de la URL firmada
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })),
  );

  db.message.seed({
    id: 'audio_1', tenantId: TENANT, conversationId: 'conv_1', whatsappAccountId: 'acc_1',
    direction: 'INBOUND', type: 'AUDIO', mediaStatus: 'DOWNLOADED',
    mediaUrl: 'ten_1/conv_1/audio_1/nota.ogg', mediaMimeType: 'audio/ogg',
    mediaFilename: 'nota.ogg', timestamp: new Date(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

describe('transcribeMessage', () => {
  it('sin GROQ_API_KEY → 503 claro (feature apagada)', async () => {
    delete process.env.GROQ_API_KEY;
    await expect(service.transcribeMessage(TENANT, 'audio_1')).rejects.toThrow(/GROQ_API_KEY/);
  });

  it('happy path: transcribe, guarda, emite message.updated y devuelve el mensaje', async () => {
    const result = (await service.transcribeMessage(TENANT, 'audio_1')) as {
      message: { transcription: string };
      cached: boolean;
    };
    expect(result.cached).toBe(false);
    expect(result.message.transcription).toBe('hola quiero dos rolls');

    expect(storage.getPresignedUrl).toHaveBeenCalledWith('ten_1/conv_1/audio_1/nota.ogg', 120);
    expect(transcriber).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/ogg', filename: 'nota.ogg' }),
    );
    expect(db.message.findFirst({ where: { id: 'audio_1' } })!.transcription).toBe(
      'hola quiero dos rolls',
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        type: 'message.updated',
        payload: expect.objectContaining({
          id: 'audio_1',
          changes: { transcription: 'hola quiero dos rolls' },
        }),
      }),
    );
  });

  it('CACHE: la segunda llamada devuelve lo guardado sin tocar el proveedor', async () => {
    await service.transcribeMessage(TENANT, 'audio_1');
    transcriber.mockClear();
    publish.mockClear();

    const again = (await service.transcribeMessage(TENANT, 'audio_1')) as { cached: boolean };
    expect(again.cached).toBe(true);
    expect(transcriber).not.toHaveBeenCalled(); // se paga UNA vez
    expect(publish).not.toHaveBeenCalled();
  });

  it('mensaje que no es audio → 400', async () => {
    db.message.seed({
      id: 'texto_1', tenantId: TENANT, conversationId: 'conv_1', whatsappAccountId: 'acc_1',
      direction: 'INBOUND', type: 'TEXT', body: 'hola', timestamp: new Date(),
    });
    await expect(service.transcribeMessage(TENANT, 'texto_1')).rejects.toThrow(BadRequestException);
  });

  it('audio todavía no descargado → 400 accionable', async () => {
    db.message.seed({
      id: 'audio_pend', tenantId: TENANT, conversationId: 'conv_1', whatsappAccountId: 'acc_1',
      direction: 'INBOUND', type: 'AUDIO', mediaStatus: 'PENDING', timestamp: new Date(),
    });
    await expect(service.transcribeMessage(TENANT, 'audio_pend')).rejects.toThrow(/descargarse/);
  });

  it('tenant-scoping: audio de otro tenant → 404 indistinguible', async () => {
    await expect(service.transcribeMessage('ten_2', 'audio_1')).rejects.toThrow(NotFoundException);
  });

  it('falla del proveedor → 502 y NO persiste nada (reintentable)', async () => {
    transcriber.mockRejectedValueOnce(new Error('rate limit exceeded'));
    await expect(service.transcribeMessage(TENANT, 'audio_1')).rejects.toThrow(/rate limit/);
    expect(db.message.findFirst({ where: { id: 'audio_1' } })!.transcription).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('audio sin voz (texto vacío) → placeholder honesto, no un null eterno', async () => {
    transcriber.mockResolvedValueOnce('');
    const result = (await service.transcribeMessage(TENANT, 'audio_1')) as {
      message: { transcription: string };
    };
    expect(result.message.transcription).toBe('(audio sin voz detectable)');
  });
});
