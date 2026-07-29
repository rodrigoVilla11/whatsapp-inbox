/**
 * Pedidos de Gourmetify en el chat: ingesta por webhook (guard por secreto,
 * upsert idempotente, evento order.updated) + lectura por conversación
 * (activos / últimos 3, tenant-scoping, backfill del link por teléfono).
 */
import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMAIN_EVENT_PUBLISHER } from '../src/events/domain-events';
import { GourmetifyOrdersController } from '../src/gourmetify/orders.controller';
import { GourmetifyOrdersService } from '../src/gourmetify/orders.service';
import { ProvisioningAuthMiddleware } from '../src/provisioning/provisioning-auth.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { createFakeDb, type FakeDb } from './support/fake-db';

const SECRET = 'clave-orders-test';
const TENANT = 'ten_1';
const OTRO_TENANT = 'ten_2';

let app: NestExpressApplication;
let db: FakeDb;
let service: GourmetifyOrdersService;
let publish: ReturnType<typeof vi.fn>;

const baseOrder = (over: Record<string, unknown> = {}) => ({
  gourmetifyTenantId: 'gfy_1',
  order: {
    id: 'ord_1',
    number: '123',
    customerPhone: '+54 9 341 555-0001',
    statusLabel: 'En preparación',
    statusKind: 'in_progress',
    summary: '2x Roll Nova, 1x Sésamo',
    totalLabel: '$ 18.500',
    scheduledLabel: 'Retira 21:30',
    createdAt: '2026-07-28T20:00:00Z',
    ...over,
  },
});

const post = (body: unknown, key: string = SECRET) =>
  request(app.getHttpServer()).post('/gourmetify/orders').set('x-provisioning-key', key).send(body as object);

beforeAll(async () => {
  Logger.overrideLogger(false);
  process.env.PROVISIONING_SECRET = SECRET;
  db = createFakeDb();
  publish = vi.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    controllers: [GourmetifyOrdersController],
    providers: [
      GourmetifyOrdersService,
      { provide: PrismaService, useValue: { db } as unknown as PrismaService },
      { provide: DOMAIN_EVENT_PUBLISHER, useValue: { publish } },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(false);
  const middleware = new ProvisioningAuthMiddleware();
  app.use((req: never, res: never, next: never) => middleware.use(req, res, next));
  await app.init();
  service = moduleRef.get(GourmetifyOrdersService);
});

afterAll(async () => {
  await app.close();
  delete process.env.PROVISIONING_SECRET;
});

beforeEach(() => {
  publish.mockClear();
  db.tenant.rows.length = 0;
  db.contact.rows.length = 0;
  db.conversation.rows.length = 0;
  db.gourmetifyOrder.rows.length = 0;
  db.tenant.seed({ id: TENANT, slug: 'nova', name: 'Nova', gourmetifyTenantId: 'gfy_1' });
  db.tenant.seed({ id: OTRO_TENANT, slug: 'otro', name: 'Otro', gourmetifyTenantId: 'gfy_2' });
});

describe('POST /gourmetify/orders (ingesta)', () => {
  it('sin clave → 401', async () => {
    await request(app.getHttpServer()).post('/gourmetify/orders').send(baseOrder()).expect(401);
  });

  it('crea el espejo del pedido, linkea el contacto por teléfono y emite order.updated', async () => {
    db.contact.seed({ id: 'ct_1', tenantId: TENANT, waId: '5493415550001' });

    const res = await post(baseOrder()).expect(200);
    expect(res.body.order).toMatchObject({
      gourmetifyOrderId: 'ord_1',
      number: '123',
      statusKind: 'in_progress',
      contactId: 'ct_1', // teléfono normalizado → contacto linkeado
    });
    expect(JSON.stringify(res.body)).not.toContain(TENANT); // sin tenantId

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        type: 'order.updated',
        payload: expect.objectContaining({ contactId: 'ct_1' }),
      }),
    );
  });

  it('acepta order.number numérico (dailyOrderNumber) y lo guarda como texto', async () => {
    const res = await post(baseOrder({ number: 123 })).expect(200);
    expect(res.body.order.number).toBe('123');
  });

  it('upsert idempotente: reintentos y cambios de estado NO duplican', async () => {
    await post(baseOrder()).expect(200);
    await post(baseOrder({ statusLabel: 'Listo', statusKind: 'ready' })).expect(200);

    const rows = db.gourmetifyOrder.findMany({ where: { tenantId: TENANT } });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKind).toBe('ready');
    expect(publish).toHaveBeenCalledTimes(2); // cada cambio SÍ emite
  });

  it('statusKind inválido → 400 nombrando los válidos', async () => {
    const res = await post(baseOrder({ statusKind: 'cocinando' })).expect(400);
    expect(res.body.message).toMatch(/pending \| in_progress/);
  });

  it('tenant desconocido → 404; createdAt inválido → 400', async () => {
    await post({ ...baseOrder(), gourmetifyTenantId: 'gfy_nope' }).expect(404);
    await post(baseOrder({ createdAt: 'ayer a la tarde' })).expect(400);
  });

  it('sin contacto todavía: guarda con contactId null (se linkea al leer)', async () => {
    const res = await post(baseOrder()).expect(200);
    expect(res.body.order.contactId).toBeNull();
  });
});

describe('GET pedidos por conversación (listForConversation)', () => {
  function seedConversation(tenantId: string, waId: string): string {
    db.contact.seed({ id: `ct_${waId}`, tenantId, waId });
    db.conversation.seed({
      id: `conv_${waId}`,
      tenantId,
      whatsappAccountId: 'acc_1',
      contactId: `ct_${waId}`,
    });
    return `conv_${waId}`;
  }

  function seedOrder(id: string, kind: string, createdAt: string, over: Record<string, unknown> = {}): void {
    db.gourmetifyOrder.seed({
      id,
      tenantId: TENANT,
      gourmetifyOrderId: id,
      customerPhone: '5493415550001',
      statusLabel: kind,
      statusKind: kind,
      orderCreatedAt: new Date(createdAt),
      ...over,
    });
  }

  it('parte en activos (todos) y cerrados (últimos 3), desc por fecha', async () => {
    const convId = seedConversation(TENANT, '5493415550001');
    seedOrder('a1', 'pending', '2026-07-28T21:00:00Z');
    seedOrder('a2', 'ready', '2026-07-28T20:00:00Z');
    for (let i = 0; i < 5; i++) {
      seedOrder(`d${i}`, 'done', `2026-07-2${i}T10:00:00Z`);
    }

    const result = await service.listForConversation(TENANT, convId);
    expect((result.active as Array<{ id: string }>).map((o) => o.id)).toEqual(['a1', 'a2']);
    expect(result.recent).toHaveLength(3); // tope
    expect((result.recent as Array<{ id: string }>)[0].id).toBe('d4'); // el más nuevo primero
  });

  it('encuentra por teléfono pedidos sin link y BACKFILLEA contactId', async () => {
    const convId = seedConversation(TENANT, '5493415550001');
    seedOrder('sin_link', 'pending', '2026-07-28T21:00:00Z', { contactId: null });

    const result = await service.listForConversation(TENANT, convId);
    expect(result.active).toHaveLength(1);
    expect(db.gourmetifyOrder.findFirst({ where: { id: 'sin_link' } })!.contactId).toBe(
      'ct_5493415550001',
    );
  });

  it('tenant-scoping: los pedidos de un tenant no aparecen en conversaciones de otro', async () => {
    seedOrder('ajeno', 'pending', '2026-07-28T21:00:00Z');
    const convOtro = (() => {
      db.contact.seed({ id: 'ct_otro', tenantId: OTRO_TENANT, waId: '5493415550001' });
      db.conversation.seed({
        id: 'conv_otro',
        tenantId: OTRO_TENANT,
        whatsappAccountId: 'acc_2',
        contactId: 'ct_otro',
      });
      return 'conv_otro';
    })();

    const result = await service.listForConversation(OTRO_TENANT, convOtro);
    expect(result.active).toHaveLength(0); // mismo teléfono, otro tenant: invisible
  });

  it('conversación inexistente → 404', async () => {
    await expect(service.listForConversation(TENANT, 'nope')).rejects.toThrow(NotFoundException);
  });
});
