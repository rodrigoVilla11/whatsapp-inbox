import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaAccessService } from '../src/media/media-access.service';
import { OutboundMediaService } from '../src/media/outbound-media.service';
import { RetentionService } from '../src/retention/retention.service';
import { SendMessageService } from '../src/messaging/send-message.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';
import { FakeMediaStorage } from './support/fake-media-storage';

const TENANT = 'ten_1';
// JPEG real por magic bytes (FF D8 FF) + relleno
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('resto-jpeg')]);

const configStub = { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService;

let db: FakeDb;
let storage: FakeMediaStorage;
let graph: {
  sendMessage: ReturnType<typeof vi.fn>;
  uploadMedia: ReturnType<typeof vi.fn>;
};
let outbound: OutboundMediaService;
let access: MediaAccessService;

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  db = createFakeDb();
  storage = new FakeMediaStorage();
  graph = {
    sendMessage: vi.fn().mockResolvedValue({ wamid: 'wamid.MEDIA.1' }),
    uploadMedia: vi.fn().mockResolvedValue('meta-media-99'),
  };
  const prisma = { db } as unknown as PrismaService;
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const send = new SendMessageService(prisma, graph as unknown as GraphApiClient, events);
  outbound = new OutboundMediaService(prisma, graph as unknown as GraphApiClient, send, storage);
  access = new MediaAccessService(prisma, configStub, storage);

  db.whatsappAccount.seed({ id: 'acc_1', tenantId: TENANT, phoneNumberId: 'PN_1' });
  db.contact.seed({ id: 'contact_1', tenantId: TENANT, waId: '5493415550001' });
  db.conversation.seed({
    id: 'conv_1',
    tenantId: TENANT,
    whatsappAccountId: 'acc_1',
    contactId: 'contact_1',
    lastInboundAt: new Date(), // ventana abierta
  });
});

const input = (over: Partial<Parameters<OutboundMediaService['sendMedia']>[2]> = {}) => ({
  clientDedupKey: 'media-dedup-001',
  buffer: JPEG,
  declaredMime: 'image/jpeg',
  filename: 'foto sushi.jpg',
  caption: 'el pedido quedó así',
  ...over,
});

describe('OutboundMediaService', () => {
  it('multipart válido → R2 + Meta + Message con media_id, key con messageId y DOWNLOADED', async () => {
    const outcome = await outbound.sendMedia(TENANT, 'conv_1', input(), 'user_1');

    expect(outcome.httpStatus).toBe(201);
    expect(storage.putCount).toBe(1);
    expect(graph.uploadMedia).toHaveBeenCalledTimes(1);
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    // payload de envío con media_id (no link)
    expect(graph.sendMessage.mock.calls[0][1]).toMatchObject({
      type: 'image',
      image: { id: 'meta-media-99', caption: 'el pedido quedó así' },
    });

    const msg = db.message.rows[0];
    expect(msg).toMatchObject({
      type: 'IMAGE',
      direction: 'OUTBOUND',
      mediaId: 'meta-media-99',
      mediaStatus: 'DOWNLOADED', // ya lo tenemos nosotros
      wamid: 'wamid.MEDIA.1',
      body: 'el pedido quedó así',
    });
    // key = {tenant}/{conv}/{messageId}/{filename sanitizado}
    expect(msg.mediaUrl).toBe(`${TENANT}/conv_1/${msg.id}/foto_sushi.jpg`);
    expect(storage.objects.has(msg.mediaUrl as string)).toBe(true);
  });

  it('content-type falsificado (png declarado, bytes jpeg) → 422 sin subir NADA', async () => {
    const outcome = await outbound.sendMedia(
      TENANT,
      'conv_1',
      input({ declaredMime: 'image/png', clientDedupKey: 'media-dedup-002' }),
      null,
    );
    expect(outcome.httpStatus).toBe(422);
    expect(outcome.error?.code).toBe('MEDIA_INVALID');
    expect(storage.putCount).toBe(0);
    expect(graph.uploadMedia).not.toHaveBeenCalled();
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });

  it('tipo fuera de la allowlist → 422; tamaño excedido → 413; ventana cerrada → 422', async () => {
    const svg = await outbound.sendMedia(
      TENANT, 'conv_1',
      input({ declaredMime: 'image/svg+xml', clientDedupKey: 'media-dedup-003' }),
      null,
    );
    expect(svg.error?.code).toBe('MEDIA_INVALID');

    const big = await outbound.sendMedia(
      TENANT, 'conv_1',
      input({
        buffer: Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]),
        clientDedupKey: 'media-dedup-004',
      }),
      null,
    );
    expect(big.httpStatus).toBe(413);
    expect(big.error?.code).toBe('MEDIA_TOO_LARGE');

    db.conversation.rows[0].lastInboundAt = new Date(Date.now() - 25 * 3600 * 1000);
    const closed = await outbound.sendMedia(
      TENANT, 'conv_1', input({ clientDedupKey: 'media-dedup-005' }), null,
    );
    expect(closed.error?.code).toBe('WINDOW_EXPIRED');
    expect(storage.putCount).toBe(0); // ninguno subió nada
  });

  it('dedup repetido → mismo mensaje sin re-subir a R2 ni a Meta', async () => {
    await outbound.sendMedia(TENANT, 'conv_1', input(), null);
    const replay = await outbound.sendMedia(TENANT, 'conv_1', input(), null);

    expect(replay.httpStatus).toBe(200);
    expect(storage.putCount).toBe(1);
    expect(graph.uploadMedia).toHaveBeenCalledTimes(1);
  });
});

describe('MediaAccessService (servido)', () => {
  beforeEach(async () => {
    await outbound.sendMedia(TENANT, 'conv_1', input(), null);
  });

  it('DOWNLOADED → URL firmada con la key', async () => {
    const msg = db.message.rows[0];
    const result = await access.resolve(TENANT, msg.id as string);
    expect(result).toMatchObject({ kind: 'redirect' });
    expect((result as { url: string }).url).toContain(msg.mediaUrl as string);
    expect((result as { url: string }).url).toContain('signed=1');
  });

  it('mensaje de otro tenant → 404 (invisible por scope)', async () => {
    const msg = db.message.rows[0];
    await expect(access.resolve('otro_tenant', msg.id as string)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('PENDING → conflict con el estado (la UI muestra "descargando…")', async () => {
    db.message.seed({
      id: 'msg_pending',
      tenantId: TENANT,
      conversationId: 'conv_1',
      whatsappAccountId: 'acc_1',
      direction: 'INBOUND',
      type: 'IMAGE',
      mediaId: 'meta_x',
      mediaStatus: 'PENDING',
      timestamp: new Date(),
    });
    const result = await access.resolve(TENANT, 'msg_pending');
    expect(result).toEqual({ kind: 'conflict', mediaStatus: 'PENDING' });
  });
});

describe('RetentionService.purgeContact con media real', () => {
  it('borra las keys del storage además de las filas', async () => {
    await outbound.sendMedia(TENANT, 'conv_1', input(), null);
    const key = db.message.rows[0].mediaUrl as string;
    expect(storage.objects.has(key)).toBe(true);

    const retention = new RetentionService(
      { db } as unknown as PrismaService,
      configStub,
      storage,
    );
    const result = await retention.purgeContact(TENANT, 'contact_1');

    expect(result.mediaObjectsDeleted).toBe(1);
    expect(storage.deletedKeys).toContain(key);
    expect(storage.objects.has(key)).toBe(false);
    expect(db.message.rows).toHaveLength(0);
    expect(db.conversation.rows).toHaveLength(0);
    expect(db.contact.rows).toHaveLength(0);
  });
});
