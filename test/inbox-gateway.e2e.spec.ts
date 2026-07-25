/**
 * Integración con REDIS REAL (el del docker-compose, :6380).
 *
 * Flujo completo verificado: POST firmado al webhook → "worker" (handler
 * real invocado por el mock de cola) → publish al canal de Redis REAL →
 * gateway suscripto → socket cliente recibe message.created.
 *
 * Requiere `npm run db:up` (Redis arriba) — igual que el resto del entorno
 * de dev. La DB es el fake in-memory: lo que se integra acá es el pub/sub.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '../src/crypto/encryption';
import { EncryptionService } from '../src/crypto/encryption.service';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../src/events/domain-events';
import { InboxGateway } from '../src/events/inbox.gateway';
import { RedisEventPublisher } from '../src/events/redis-event-publisher';
import { configureBodyParsers } from '../src/http/body-parsers';
import { PrismaService } from '../src/prisma/prisma.service';
import { WEBHOOK_EVENTS_QUEUE } from '../src/queue/queue.constants';
import { TenantContextService } from '../src/tenant/tenant-context.service';
import { InboundMessagesService } from '../src/webhook-worker/inbound-messages.service';
import { MessageStatusesService } from '../src/webhook-worker/message-statuses.service';
import { WebhookEventHandler } from '../src/webhook-worker/webhook-event.handler';
import { MetaAppsService } from '../src/webhooks/meta-apps.service';
import { computeMetaSignature } from '../src/webhooks/webhook-signature';
import { WebhooksController } from '../src/webhooks/webhooks.controller';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { createFakeDb } from './support/fake-db';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TENANT_A = 'ten_A';
const TENANT_B = 'ten_B';
const APP_SECRET = 'gw-test-secret';
const PNID = 'PN_GW_1';

const encryption = new Encryption({ keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 });

const waitForEvent = <T>(socket: ClientSocket, event: string, timeoutMs = 4000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('InboxGateway (integración con Redis real)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let publisher: DomainEventPublisher;
  let resolveMock: ReturnType<typeof vi.fn>;
  const db = createFakeDb();
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);

    db.metaApp.seed({
      id: 'app_1',
      ref: 'default',
      name: 'GW Test',
      appId: '1',
      appSecretEnc: encryption.encrypt(APP_SECRET),
      verifyTokenEnc: encryption.encrypt('vt'),
      keyVersion: 1,
    });
    db.whatsappAccount.seed({
      id: 'acc_1',
      tenantId: TENANT_A,
      phoneNumberId: PNID,
      wabaId: 'waba',
      metaAppId: 'app_1',
    });

    resolveMock = vi.fn().mockResolvedValue({ tenantId: TENANT_A, userId: null });

    const prisma = { db } as unknown as PrismaService;
    const configStub = { get: (key: string) => (key === 'REDIS_URL' ? REDIS_URL : undefined) };

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        MetaAppsService,
        InboxGateway,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: encryption },
        { provide: ConfigService, useValue: configStub },
        { provide: TenantContextService, useValue: { resolveDefault: resolveMock } },
        {
          provide: DOMAIN_EVENT_PUBLISHER,
          useFactory: () => new RedisEventPublisher(REDIS_URL),
        },
        {
          // "Worker" inline: el add de la cola invoca el handler real —
          // el tramo que se integra de verdad acá es publish → Redis → gateway.
          provide: getQueueToken(WEBHOOK_EVENTS_QUEUE),
          inject: [DOMAIN_EVENT_PUBLISHER],
          useFactory: (events: DomainEventPublisher) => {
            const inbound = new InboundMessagesService(
              prisma,
              { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
              events,
            );
            const statuses = new MessageStatusesService(prisma, events);
            const handler = new WebhookEventHandler(prisma, inbound, statuses);
            return {
              add: async (_name: string, data: { webhookEventId: string }) => {
                await handler.handle(data.webhookEventId);
                return { id: data.webhookEventId };
              },
            };
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(false);
    configureBodyParsers(app);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    publisher = moduleRef.get(DOMAIN_EVENT_PUBLISHER);
  });

  afterAll(async () => {
    for (const socket of openSockets) socket.disconnect();
    await app.close();
  });

  beforeEach(() => {
    resolveMock.mockResolvedValue({ tenantId: TENANT_A, userId: null });
  });

  function connect(): ClientSocket {
    const socket = io(`${baseUrl}/inbox`, { transports: ['websocket'], reconnection: false });
    openSockets.push(socket);
    return socket;
  }

  it('FLUJO COMPLETO: webhook firmado → worker → Redis → gateway → cliente recibe message.created', async () => {
    const socket = connect();
    await waitForEvent(socket, 'connect');
    await sleep(100); // join al room asentado

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PNID },
                contacts: [{ wa_id: '5493415550001', profile: { name: 'Juan GW' } }],
                messages: [
                  {
                    from: '5493415550001',
                    id: `wamid.GW.${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'hola por el gateway' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const received = waitForEvent<{ conversationId: string; message: { body: string } }>(
      socket,
      'message.created',
    );
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', computeMetaSignature(Buffer.from(body), APP_SECRET))
      .send(body)
      .expect(200);

    const payload = await received;
    expect(payload.message.body).toBe('hola por el gateway');
    expect(payload.conversationId).toBeTruthy();
  });

  it('AISLAMIENTO: evento de tenant A → socket de tenant B NO lo recibe', async () => {
    const socketA = connect();
    await waitForEvent(socketA, 'connect');

    resolveMock.mockResolvedValueOnce({ tenantId: TENANT_B, userId: null });
    const socketB = connect();
    await waitForEvent(socketB, 'connect');
    await sleep(100);

    const receivedByA: unknown[] = [];
    const receivedByB: unknown[] = [];
    socketA.on('conversation.updated', (p) => receivedByA.push(p));
    socketB.on('conversation.updated', (p) => receivedByB.push(p));

    await publisher.publish({
      tenantId: TENANT_A,
      type: 'conversation.updated',
      payload: { conversation: { id: 'conv_solo_A' } },
    });
    await sleep(300);

    expect(receivedByA).toHaveLength(1);
    expect(receivedByB).toHaveLength(0); // el test de aislamiento más importante
  });

  it('handshake sin tenant resoluble → desconexión inmediata', async () => {
    resolveMock.mockResolvedValueOnce(null);
    const socket = connect();
    // Listener ANTES del connect: el server echa tan rápido que el evento
    // puede llegar pegado al connect y perderse si se engancha después.
    const disconnected = new Promise<void>((resolve) => {
      socket.on('disconnect', () => resolve());
    });
    await waitForEvent(socket, 'connect');
    await Promise.race([
      disconnected,
      sleep(3000).then(() => Promise.reject(new Error('el server no desconectó'))),
    ]);
    expect(socket.connected).toBe(false);
  });
});
