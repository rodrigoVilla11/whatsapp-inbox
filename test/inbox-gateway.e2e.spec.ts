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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/cookies';
import { SessionsService } from '../src/auth/sessions.service';
import { Encryption } from '../src/crypto/encryption';
import { EncryptionService } from '../src/crypto/encryption.service';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../src/events/domain-events';
import { InboxGateway } from '../src/events/inbox.gateway';
import { RedisEventPublisher } from '../src/events/redis-event-publisher';
import { configureApp } from '../src/http/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { WEBHOOK_EVENTS_QUEUE } from '../src/queue/queue.constants';
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
  let tokenA: string;
  let tokenB: string;
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
    // Fase 8: el handshake valida SESIONES REALES por cookie.
    db.user.seed({ id: 'u_A', tenantId: TENANT_A, email: 'a@gw.test', name: 'Agente A' });
    db.user.seed({ id: 'u_B', tenantId: TENANT_B, email: 'b@gw.test', name: 'Agente B' });

    const prisma = { db } as unknown as PrismaService;
    const sessions = new SessionsService(prisma);
    tokenA = (await sessions.create({ id: 'u_A', tenantId: TENANT_A }, null)).token;
    tokenB = (await sessions.create({ id: 'u_B', tenantId: TENANT_B }, null)).token;

    const configStub = { get: (key: string) => (key === 'REDIS_URL' ? REDIS_URL : undefined) };

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        MetaAppsService,
        InboxGateway,
        SessionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: encryption },
        { provide: ConfigService, useValue: configStub },
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
    configureApp(app); // prefijo /api + parsers, igual que producción
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

  /** La cookie de sesión viaja en los headers del upgrade, como en el browser. */
  function connect(sessionToken?: string): ClientSocket {
    const socket = io(`${baseUrl}/inbox`, {
      path: '/api/socket.io', // un solo origen (10b): mismo path que el cliente real
      transports: ['websocket'],
      reconnection: false,
      ...(sessionToken
        ? { extraHeaders: { cookie: `${SESSION_COOKIE}=${sessionToken}` } }
        : {}),
    });
    openSockets.push(socket);
    return socket;
  }

  it('FLUJO COMPLETO: webhook firmado (SIN sesión — su auth es la firma) → worker → Redis → gateway → cliente con sesión recibe message.created', async () => {
    const socket = connect(tokenA);
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
      .post('/api/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', computeMetaSignature(Buffer.from(body), APP_SECRET))
      .send(body)
      .expect(200);

    const payload = await received;
    expect(payload.message.body).toBe('hola por el gateway');
    expect(payload.conversationId).toBeTruthy();
  });

  it('AISLAMIENTO: evento de tenant A → socket con sesión de tenant B NO lo recibe', async () => {
    const socketA = connect(tokenA);
    await waitForEvent(socketA, 'connect');

    const socketB = connect(tokenB);
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

  it('PAR DE REQUISITO (withCredentials): con cookie válida conecta y PERMANECE; el mismo cliente sin la cookie es rechazado', async () => {
    // Documenta por qué el cliente browser necesita withCredentials: sin la
    // cookie en el upgrade, el server desconecta; con ella, el socket queda.
    const withCookie = connect(tokenA);
    await waitForEvent(withCookie, 'connect');

    const withoutCookie = connect(); // simula un cliente sin withCredentials
    const rejected = new Promise<void>((resolve) => {
      withoutCookie.on('disconnect', () => resolve());
    });
    await waitForEvent(withoutCookie, 'connect');
    await Promise.race([
      rejected,
      sleep(3000).then(() => Promise.reject(new Error('el server no desconectó al sin-cookie'))),
    ]);
    await sleep(200); // margen: que una desconexión tardía no pase colada

    expect(withoutCookie.connected).toBe(false);
    expect(withCookie.connected).toBe(true); // el autenticado sigue firme
  });

  it('handshake SIN cookie de sesión → desconexión inmediata', async () => {
    const socket = connect(); // sin cookie
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

  it('handshake con cookie INVÁLIDA → desconexión inmediata', async () => {
    const socket = connect('token-falso-que-no-existe');
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
