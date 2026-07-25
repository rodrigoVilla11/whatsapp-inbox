import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaSweepService } from '../src/media/media-sweep.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';
const HOUR = 3600 * 1000;

let db: FakeDb;
let queue: { add: ReturnType<typeof vi.fn> };
let service: MediaSweepService;

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  db = createFakeDb();
  queue = { add: vi.fn().mockResolvedValue({}) };
  service = new MediaSweepService(
    { db } as unknown as PrismaService,
    queue as unknown as Queue,
  );
  db.tenant.seed({ id: TENANT, slug: 'nova-sushi', name: 'Nova Sushi' });
});

function seedMessage(id: string, over: Record<string, unknown>): void {
  db.message.seed({
    id,
    tenantId: TENANT,
    conversationId: 'conv_1',
    whatsappAccountId: 'acc_1',
    direction: 'INBOUND',
    type: 'IMAGE',
    mediaId: `meta_${id}`,
    timestamp: new Date(),
    ...over,
  });
}

describe('MediaSweepService (barrido de media huérfana)', () => {
  it('PENDING viejo → re-encolado con jobId de sweep; reciente y DOWNLOADED → no', async () => {
    seedMessage('msg_viejo', {
      mediaStatus: 'PENDING',
      createdAt: new Date(Date.now() - 2 * HOUR), // huérfano real
    });
    seedMessage('msg_reciente', {
      mediaStatus: 'PENDING',
      createdAt: new Date(Date.now() - 5 * 60 * 1000), // su job todavía puede estar en vuelo
    });
    seedMessage('msg_bajado', {
      mediaStatus: 'DOWNLOADED',
      createdAt: new Date(Date.now() - 2 * HOUR),
    });

    const rescued = await service.rescueOrphans();

    expect(rescued).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'download-media',
      { tenantId: TENANT, messageId: 'msg_viejo' },
      { jobId: 'media-sweep-msg_viejo' }, // distinto del original: un job FAILED
      //                                     retenido en Redis no bloquea el rescate
    );
  });

  it('sin huérfanos → 0 rescatados y ningún encolado', async () => {
    seedMessage('msg_ok', { mediaStatus: 'DOWNLOADED', createdAt: new Date(Date.now() - HOUR) });
    const rescued = await service.rescueOrphans();
    expect(rescued).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('FAILED no se re-encola (el rescate es solo para PENDING sin job)', async () => {
    seedMessage('msg_failed', {
      mediaStatus: 'FAILED',
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    expect(await service.rescueOrphans()).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
