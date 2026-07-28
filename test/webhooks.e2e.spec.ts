import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '../src/crypto/encryption';
import { EncryptionService } from '../src/crypto/encryption.service';
import { configureApp } from '../src/http/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { WEBHOOK_EVENTS_QUEUE } from '../src/queue/queue.constants';
import { MetaAppsService } from '../src/webhooks/meta-apps.service';
import { computeMetaSignature } from '../src/webhooks/webhook-signature';
import { WebhooksController } from '../src/webhooks/webhooks.controller';
import { WebhooksService } from '../src/webhooks/webhooks.service';

const APP_SECRET = 'test-app-secret-123';
const VERIFY_TOKEN = 'test-verify-token-xyz';

// Cifrado REAL con clave de test: el e2e cubre también el camino de descifrado.
const encryption = new Encryption({
  keys: new Map([[1, randomBytes(32)]]),
  activeVersion: 1,
});

const metaAppRow = {
  id: 'app_1',
  ref: 'default',
  name: 'Test App',
  appId: '1234567890',
  appSecretEnc: encryption.encrypt(APP_SECRET),
  verifyTokenEnc: encryption.encrypt(VERIFY_TOKEN),
  keyVersion: 1,
  graphVersion: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const prismaMock = {
  db: {
    metaApp: { findUnique: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn() },
  },
};
const queueMock = { add: vi.fn() };

const sign = (body: string): string => computeMetaSignature(Buffer.from(body, 'utf8'), APP_SECRET);

describe('Webhooks (e2e)', () => {
  let app: NestExpressApplication;
  let server: ReturnType<NestExpressApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        MetaAppsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: EncryptionService, useValue: encryption },
        { provide: getQueueToken(WEBHOOK_EVENTS_QUEUE), useValue: queueMock },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(false);
    configureApp(app); // prefijo /api + parsers, igual que producción
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.db.metaApp.findUnique.mockImplementation(({ where }: { where: { ref: string } }) =>
      Promise.resolve(where.ref === 'default' ? metaAppRow : null),
    );
    prismaMock.db.webhookEvent.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ id: 'evt_1', ...data }),
    );
    prismaMock.db.webhookEvent.update.mockResolvedValue({});
    queueMock.add.mockResolvedValue({ id: 'evt_1' });
  });

  describe('GET /webhooks/whatsapp (verificación de Meta)', () => {
    it('devuelve el challenge en TEXTO PLANO, sin comillas JSON', async () => {
      const res = await request(server)
        .get('/api/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        })
        .expect(200);

      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toBe('1158201444'); // NO '"1158201444"'
    });

    it('acepta el prefijo /inbox/api (shim de la integración Gourmetify)', async () => {
      // Easypanel no reescribe el path destino: la API normaliza
      // /inbox/api/* → /api/* nativamente (configureApp).
      const res = await request(server)
        .get('/inbox/api/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '77' })
        .expect(200);
      expect(res.text).toBe('77');
    });

    it('acepta también la ruta con :ref explícito', async () => {
      const res = await request(server)
        .get('/api/webhooks/whatsapp/default')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '42' })
        .expect(200);
      expect(res.text).toBe('42');
    });

    it('rechaza con 403 el token incorrecto', async () => {
      await request(server)
        .get('/api/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' })
        .expect(403);
    });

    it('rechaza con 403 un modo distinto de subscribe', async () => {
      await request(server)
        .get('/api/webhooks/whatsapp')
        .query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'x' })
        .expect(403);
    });

    it('responde 404 si el :ref no existe (solo en GET)', async () => {
      await request(server)
        .get('/api/webhooks/whatsapp/no-existe')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'x' })
        .expect(404);
    });
  });

  describe('POST /webhooks/whatsapp', () => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

    const post = (body: string, headers: Record<string, string> = {}) => {
      let req = request(server).post('/api/webhooks/whatsapp').set('content-type', 'application/json');
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      return req.send(body);
    };

    it('firma válida → 200, evento RECEIVED persistido, job encolado con el id, QUEUED', async () => {
      await post(payload, { 'x-hub-signature-256': sign(payload) }).expect(200);

      expect(prismaMock.db.webhookEvent.create).toHaveBeenCalledTimes(1);
      const created = prismaMock.db.webhookEvent.create.mock.calls[0][0].data;
      expect(created).toMatchObject({
        metaAppId: 'app_1',
        signatureValid: true,
        status: 'RECEIVED',
        payload: { object: 'whatsapp_business_account', entry: [] },
      });

      // El job lleva SOLO el id del evento, no el payload.
      expect(queueMock.add).toHaveBeenCalledWith(
        'process-webhook-event',
        { webhookEventId: 'evt_1' },
        { jobId: 'evt_1' },
      );
      expect(prismaMock.db.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt_1' },
        data: { status: 'QUEUED' },
      });
    });

    it('firma inválida → 401, y NO se persiste ni encola nada', async () => {
      await post(payload, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }).expect(401);
      expect(prismaMock.db.webhookEvent.create).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('header ausente → 401', async () => {
      await post(payload).expect(401);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('firma de longitud distinta → 401 limpio, sin excepción sin manejar', async () => {
      // timingSafeEqual tira ante buffers de longitud distinta; esto documenta
      // que el chequeo de longitud previo lo convierte en un 401 normal.
      await post(payload, { 'x-hub-signature-256': 'sha256=abcd' }).expect(401);
      await post(payload, { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(63) }).expect(401);
      expect(prismaMock.db.webhookEvent.create).not.toHaveBeenCalled();
    });

    it(':ref inexistente → 200 igual (no 404) y evento DISCARDED sin encolar', async () => {
      await request(server)
        .post('/api/webhooks/whatsapp/no-existe')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sign(payload))
        .send(payload)
        .expect(200);

      expect(prismaMock.db.webhookEvent.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.db.webhookEvent.create.mock.calls[0][0].data).toMatchObject({
        signatureValid: false,
        status: 'DISCARDED',
      });
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('body no-JSON con firma válida → 200 sin crash, payload crudo como string', async () => {
      const broken = '{esto no es json válido';
      await post(broken, { 'x-hub-signature-256': sign(broken) }).expect(200);

      expect(prismaMock.db.webhookEvent.create.mock.calls[0][0].data.payload).toBe(broken);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });

    it('LA REGRESIÓN CLÁSICA: la firma es sobre el raw body, no sobre JSON.stringify(req.body)', async () => {
      // Body con espacios y formato que se pierden al parsear y re-serializar.
      const rawWire = '{"object": "whatsapp_business_account",   "entry": [ { "id": "0" } ]}';
      const reSerialized = JSON.stringify(JSON.parse(rawWire));
      expect(reSerialized).not.toBe(rawWire); // el bug existe: son bytes distintos

      // Firma calculada sobre la RE-serialización (el bug clásico) → NO valida.
      await post(rawWire, { 'x-hub-signature-256': sign(reSerialized) }).expect(401);

      // Firma sobre los bytes exactos del wire → valida.
      await post(rawWire, { 'x-hub-signature-256': sign(rawWire) }).expect(200);
    });

    it('body > 1MB → 413 del parser, sin llegar al controller ni persistir nada', async () => {
      const big = '{"pad":"' + 'a'.repeat(1024 * 1024) + '"}'; // ~1MB + overhead
      await post(big, { 'x-hub-signature-256': sign(big) }).expect(413);
      expect(prismaMock.db.webhookEvent.create).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('error interno tras firma válida (encolado falla) → 200 igual y evento FAILED', async () => {
      queueMock.add.mockRejectedValueOnce(new Error('redis caído'));

      await post(payload, { 'x-hub-signature-256': sign(payload) }).expect(200);

      expect(prismaMock.db.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt_1' },
        data: { status: 'FAILED', error: 'redis caído' },
      });
    });
  });
});
