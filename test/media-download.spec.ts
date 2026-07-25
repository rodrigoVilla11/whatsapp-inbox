import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaDownloadService } from '../src/media/media-download.service';
import { MediaTooLargeError } from '../src/media/media-limits';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';
import { FakeMediaStorage } from './support/fake-media-storage';

const TENANT = 'ten_1';
const BODY = Buffer.from('bytes-de-una-imagen-jpeg');
const SHA_HEX = createHash('sha256').update(BODY).digest('hex');

let db: FakeDb;
let storage: FakeMediaStorage;
let graph: { getMediaInfo: ReturnType<typeof vi.fn>; downloadMediaBinary: ReturnType<typeof vi.fn> };
let events: { publish: ReturnType<typeof vi.fn> };
let service: MediaDownloadService;

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  db = createFakeDb();
  storage = new FakeMediaStorage();
  graph = { getMediaInfo: vi.fn(), downloadMediaBinary: vi.fn() };
  events = { publish: vi.fn().mockResolvedValue(undefined) };
  service = new MediaDownloadService(
    { db } as unknown as PrismaService,
    graph as unknown as GraphApiClient,
    storage,
    events,
  );
  db.whatsappAccount.seed({ id: 'acc_1', tenantId: TENANT, phoneNumberId: 'PN_1', accessTokenEnc: 'v1.1.x' });
  db.message.seed({
    id: 'msg_1',
    tenantId: TENANT,
    conversationId: 'conv_1',
    whatsappAccountId: 'acc_1',
    direction: 'INBOUND',
    type: 'IMAGE',
    mediaId: 'meta_media_1',
    mediaSha256: SHA_HEX,
    mediaMimeType: 'image/jpeg',
    mediaStatus: 'PENDING',
    timestamp: new Date(),
  });
  graph.getMediaInfo.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/x/1',
    mimeType: 'image/jpeg',
    sha256: null,
    fileSizeBytes: BODY.length,
  });
  graph.downloadMediaBinary.mockResolvedValue(BODY);
});

const JOB = { tenantId: TENANT, messageId: 'msg_1' };

describe('MediaDownloadService', () => {
  it('camino feliz: dos GETs → sha verificado → objeto en R2 → key + DOWNLOADED', async () => {
    const outcome = await service.download(JOB);

    expect(outcome).toBe('downloaded');
    expect(graph.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(graph.downloadMediaBinary).toHaveBeenCalledTimes(1);

    const msg = db.message.rows[0];
    expect(msg.mediaStatus).toBe('DOWNLOADED');
    expect(msg.mediaSizeBytes).toBe(BODY.length);
    // mediaUrl = KEY con tenant primero, no URL
    expect(msg.mediaUrl).toBe(`${TENANT}/conv_1/msg_1/media.jpg`);
    expect(storage.objects.has(msg.mediaUrl as string)).toBe(true);
    expect(storage.objects.get(msg.mediaUrl as string)?.contentType).toBe('image/jpeg');
  });

  it('SHA mismatch → throw (reintento), sin marcar DOWNLOADED', async () => {
    graph.downloadMediaBinary.mockResolvedValueOnce(Buffer.from('bytes-adulterados'));
    await expect(service.download(JOB)).rejects.toThrow(/SHA-256/);
    expect(db.message.rows[0].mediaStatus).toBe('PENDING');
    expect(storage.putCount).toBe(0);
  });

  it('URL expirada en el 1er intento → el 2do pide URL FRESCA y completa', async () => {
    const { GraphApiError } = await import('../src/whatsapp/graph-api.client');
    graph.downloadMediaBinary.mockRejectedValueOnce(new GraphApiError(404, undefined));

    await expect(service.download(JOB)).rejects.toThrow(); // intento 1 falla → BullMQ reintenta
    await expect(service.download(JOB)).resolves.toBe('downloaded'); // intento 2 OK

    // getMediaInfo se llamó UNA vez por intento: cada retry usa URL fresca
    expect(graph.getMediaInfo).toHaveBeenCalledTimes(2);
    expect(db.message.rows[0].mediaStatus).toBe('DOWNLOADED');
  });

  it('tamaño declarado excedido → FAILED terminal SIN descargar ni reintentar', async () => {
    graph.getMediaInfo.mockResolvedValueOnce({
      url: 'https://lookaside/x',
      mimeType: 'image/jpeg',
      sha256: null,
      fileSizeBytes: 6 * 1024 * 1024, // > 5MB imagen
    });
    const outcome = await service.download(JOB);

    expect(outcome).toBe('failed-terminal'); // return, no throw → sin reintento
    expect(graph.downloadMediaBinary).not.toHaveBeenCalled();
    expect(db.message.rows[0].mediaStatus).toBe('FAILED');
    expect(db.message.rows[0].errorDetail).toMatch(/excede/);
  });

  it('tamaño real excedido durante la descarga → FAILED terminal', async () => {
    graph.downloadMediaBinary.mockRejectedValueOnce(new MediaTooLargeError(9_999_999, 5_242_880));
    const outcome = await service.download(JOB);
    expect(outcome).toBe('failed-terminal');
    expect(db.message.rows[0].mediaStatus).toBe('FAILED');
  });

  it('re-ejecución sobre mensaje DOWNLOADED → no re-sube (idempotente)', async () => {
    await service.download(JOB);
    expect(storage.putCount).toBe(1);

    const outcome = await service.download(JOB);
    expect(outcome).toBe('skipped');
    expect(storage.putCount).toBe(1); // sin put nuevo
    expect(graph.getMediaInfo).toHaveBeenCalledTimes(1); // ni siquiera consulta a Meta
  });

  it('markFailed no pisa un DOWNLOADED previo', async () => {
    await service.download(JOB);
    await service.markFailed(JOB, 'reintento tardío perdido');
    expect(db.message.rows[0].mediaStatus).toBe('DOWNLOADED');
  });

  it('DOWNLOADED → publica message.updated con mediaStatus (y FAILED también)', async () => {
    await service.download(JOB);
    const downloaded = events.publish.mock.calls.find((c) => c[0].type === 'message.updated')![0];
    expect(downloaded.tenantId).toBe(TENANT);
    expect(downloaded.payload).toMatchObject({
      id: 'msg_1',
      conversationId: 'conv_1',
      changes: { mediaStatus: 'DOWNLOADED', mediaMimeType: 'image/jpeg' },
    });

    // FAILED emite lo suyo (mensaje nuevo, marcado terminal)
    events.publish.mockClear();
    db.message.seed({
      id: 'msg_2',
      tenantId: TENANT,
      conversationId: 'conv_1',
      whatsappAccountId: 'acc_1',
      direction: 'INBOUND',
      type: 'IMAGE',
      mediaId: 'meta_x',
      mediaStatus: 'PENDING',
      timestamp: new Date(),
    });
    await service.markFailed({ tenantId: TENANT, messageId: 'msg_2' }, 'agotado');
    expect(events.publish.mock.calls[0][0].payload.changes).toEqual({ mediaStatus: 'FAILED' });

    // pero un markFailed sobre DOWNLOADED no emite nada
    events.publish.mockClear();
    await service.markFailed(JOB, 'tardío');
    expect(events.publish).not.toHaveBeenCalled();
  });
});
