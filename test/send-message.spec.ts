import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { SendMessageService } from '../src/messaging/send-message.service';
import { GraphApiClient, GraphApiError } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';
const NOW_OPEN = new Date(); // lastInboundAt reciente → ventana abierta

let db: FakeDb;
let graph: { sendMessage: ReturnType<typeof vi.fn>; listTemplates: ReturnType<typeof vi.fn> };
let events: { publish: ReturnType<typeof vi.fn> };
let service: SendMessageService;

function makeService(): SendMessageService {
  const prisma = { db } as unknown as PrismaService;
  const svc = new SendMessageService(prisma, graph as unknown as GraphApiClient, events);
  (svc as unknown as { rateLimitBackoffMs: number }).rateLimitBackoffMs = 1; // sin esperas reales
  return svc;
}

function seedConversation(over: Record<string, unknown> = {}): void {
  db.whatsappAccount.seed({
    id: 'acc_1',
    tenantId: TENANT,
    phoneNumberId: 'PN_1',
    wabaId: 'waba_1',
    accessTokenEnc: 'v1.1.x.x.x',
    status: 'ACTIVE',
  });
  db.contact.seed({ id: 'contact_1', tenantId: TENANT, waId: '5493415550001' });
  db.conversation.seed({
    id: 'conv_1',
    tenantId: TENANT,
    whatsappAccountId: 'acc_1',
    contactId: 'contact_1',
    lastInboundAt: NOW_OPEN,
    ...over,
  });
}

function seedTemplate(over: Record<string, unknown> = {}): void {
  db.messageTemplate.seed({
    id: 'tpl_1',
    tenantId: TENANT,
    whatsappAccountId: 'acc_1',
    name: 'pedido_listo',
    language: 'es_AR',
    category: 'UTILITY',
    status: 'APPROVED',
    bodyText: 'Hola {{1}}! Tu pedido {{2}} está listo.',
    variableCount: 2,
    ...over,
  });
}

const textReq = (key = 'dedup-key-0001') =>
  ({ clientDedupKey: key, type: 'text', body: 'llegamos en 10 minutos' }) as const;

const graphError = (httpStatus: number, code: number, message = 'meta error'): GraphApiError =>
  new GraphApiError(httpStatus, { code, message, error_data: { details: `detalle ${code}` } });

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  db = createFakeDb();
  graph = { sendMessage: vi.fn(), listTemplates: vi.fn() };
  events = { publish: vi.fn().mockResolvedValue(undefined) };
  service = makeService();
  graph.sendMessage.mockResolvedValue({ wamid: 'wamid.NEW.1' });
});

describe('SendMessageService — texto', () => {
  it('ventana abierta → PENDING → Meta → wamid persistido → conversación actualizada', async () => {
    seedConversation();
    const outcome = await service.send(TENANT, 'conv_1', textReq(), 'user_1');

    expect(outcome.httpStatus).toBe(201);
    expect(outcome.error).toBeNull();
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    // payload correcto hacia Meta
    expect(graph.sendMessage.mock.calls[0][1]).toEqual({
      to: '5493415550001',
      type: 'text',
      text: { body: 'llegamos en 10 minutos' },
    });

    const msg = db.message.rows[0];
    expect(msg).toMatchObject({
      direction: 'OUTBOUND',
      type: 'TEXT',
      status: 'PENDING', // hasta que el webhook confirme SENT (fase 3)
      wamid: 'wamid.NEW.1',
      sentByUserId: 'user_1',
      clientDedupKey: 'dedup-key-0001',
    });

    const conv = db.conversation.rows[0];
    expect(conv.lastOutboundAt).toBeInstanceOf(Date);
    expect(conv.lastMessagePreview).toBe('llegamos en 10 minutos');

    // eventos post-éxito: message.created + conversation.updated
    const types = events.publish.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['message.created', 'conversation.updated']);
  });

  it('ventana cerrada → 422 WINDOW_EXPIRED sin llamar a Meta ni persistir', async () => {
    seedConversation({ lastInboundAt: new Date(Date.now() - 25 * 3600 * 1000) });
    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);

    expect(outcome.httpStatus).toBe(422);
    expect(outcome.error?.code).toBe('WINDOW_EXPIRED');
    expect(outcome.message).toBeNull();
    expect(graph.sendMessage).not.toHaveBeenCalled();
    expect(db.message.rows).toHaveLength(0);
  });

  it('conversación inexistente → 404', async () => {
    await expect(service.send(TENANT, 'conv_nope', textReq(), null)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('SendMessageService — idempotencia del frontend', () => {
  it('clientDedupKey repetido → mismo mensaje, CERO llamadas nuevas a Meta', async () => {
    seedConversation();
    const first = await service.send(TENANT, 'conv_1', textReq('repetida-123'), null);
    const replay = await service.send(TENANT, 'conv_1', textReq('repetida-123'), null);

    expect(graph.sendMessage).toHaveBeenCalledTimes(1); // solo el primer envío
    expect(replay.httpStatus).toBe(200);
    expect((replay.message as { id: string }).id).toBe((first.message as { id: string }).id);
    expect(db.message.rows).toHaveLength(1);
  });
});

describe('SendMessageService — mapeo de errores de Meta', () => {
  it('131047 → FAILED + la ventana local pasa a cerrada + 422 WINDOW_EXPIRED', async () => {
    seedConversation(); // ventana ABIERTA según nuestros datos
    graph.sendMessage.mockRejectedValueOnce(graphError(400, 131047, 'Re-engagement message'));

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);

    expect(outcome.httpStatus).toBe(422);
    expect(outcome.error?.code).toBe('WINDOW_EXPIRED');
    expect(db.message.rows[0]).toMatchObject({ status: 'FAILED', errorCode: 131047 });

    // Meta gana: isWindowOpen ahora da false — la UI cae a modo plantilla
    const conv = db.conversation.rows[0] as { lastInboundAt: Date };
    const { isWindowOpen } = await import('../src/messaging/window');
    expect(isWindowOpen(conv)).toBe(false);

    // y la UI se entera AL INSTANTE: conversation.updated con la ventana caída
    const convEvent = events.publish.mock.calls.find(
      (c) => c[0].type === 'conversation.updated',
    )?.[0];
    expect(convEvent).toBeTruthy();
    expect(isWindowOpen(convEvent.payload.conversation)).toBe(false);
    // más el message.created del FAILED para otros agentes mirando el hilo
    expect(events.publish.mock.calls.some((c) => c[0].type === 'message.created')).toBe(true);
  });

  it('131047 NO rebobina si un entrante fresco llegó durante el intento (CAS)', async () => {
    seedConversation();
    const freshInbound = new Date(Date.now() + 50); // llega "durante" la llamada a Meta
    graph.sendMessage.mockImplementationOnce(async () => {
      // el worker persiste un entrante nuevo mientras el envío está en vuelo
      db.conversation.updateMany({
        where: { id: 'conv_1' },
        data: { lastInboundAt: freshInbound },
      });
      throw graphError(400, 131047);
    });

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);
    expect(outcome.error?.code).toBe('WINDOW_EXPIRED'); // Meta rechazó el intento viejo

    const conv = db.conversation.rows[0] as { lastInboundAt: Date };
    expect(conv.lastInboundAt.getTime()).toBe(freshInbound.getTime()); // NO pisado
    const { isWindowOpen } = await import('../src/messaging/window');
    expect(isWindowOpen(conv)).toBe(true); // la ventana recién abierta sigue abierta
  });

  it('131026 → FAILED + RECIPIENT_UNREACHABLE con mensaje claro', async () => {
    seedConversation();
    graph.sendMessage.mockRejectedValueOnce(graphError(400, 131026));

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);
    expect(outcome.httpStatus).toBe(422);
    expect(outcome.error?.code).toBe('RECIPIENT_UNREACHABLE');
    expect(outcome.error?.message).toMatch(/no tener WhatsApp|bloqueado/);
    expect(db.message.rows[0].status).toBe('FAILED');
  });

  it('130429 → un reintento → éxito en el segundo intento', async () => {
    seedConversation();
    graph.sendMessage
      .mockRejectedValueOnce(graphError(400, 130429))
      .mockResolvedValueOnce({ wamid: 'wamid.RETRY.OK' });

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);
    expect(graph.sendMessage).toHaveBeenCalledTimes(2);
    expect(outcome.httpStatus).toBe(201);
    expect(db.message.rows[0].wamid).toBe('wamid.RETRY.OK');
  });

  it('130429 persistente → RATE_LIMITED tras exactamente 2 llamadas (1 reintento, no más)', async () => {
    seedConversation();
    graph.sendMessage.mockRejectedValue(graphError(400, 130429));

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);
    expect(graph.sendMessage).toHaveBeenCalledTimes(2);
    expect(outcome.httpStatus).toBe(429);
    expect(outcome.error?.code).toBe('RATE_LIMITED');
    expect(db.message.rows[0].status).toBe('FAILED');
  });

  it('401 de Meta → cuenta TOKEN_EXPIRED + ACCOUNT_ERROR', async () => {
    seedConversation();
    graph.sendMessage.mockRejectedValueOnce(graphError(401, 190, 'Invalid OAuth access token'));

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);
    expect(outcome.httpStatus).toBe(502);
    expect(outcome.error?.code).toBe('ACCOUNT_ERROR');
    expect(db.whatsappAccount.rows[0]).toMatchObject({ status: 'TOKEN_EXPIRED', lastErrorCode: 190 });
  });

  it('error desconocido de Meta → SEND_FAILED con el código crudo', async () => {
    seedConversation();
    graph.sendMessage.mockRejectedValueOnce(graphError(500, 131000));

    const outcome = await service.send(TENANT, 'conv_1', textReq(), null);
    expect(outcome.httpStatus).toBe(502);
    expect(outcome.error?.code).toBe('SEND_FAILED');
    expect(db.message.rows[0].errorCode).toBe(131000);
  });
});

describe('SendMessageService — plantillas', () => {
  const templateReq = (params: string[], key = 'tpl-dedup-001') =>
    ({ clientDedupKey: key, type: 'template', templateId: 'tpl_1', params }) as const;

  it('plantilla con ventana CERRADA → se envía igual', async () => {
    seedConversation({ lastInboundAt: new Date(Date.now() - 48 * 3600 * 1000) });
    seedTemplate();

    const outcome = await service.send(TENANT, 'conv_1', templateReq(['Juan', '#123']), null);
    expect(outcome.httpStatus).toBe(201);
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    expect(graph.sendMessage.mock.calls[0][1]).toEqual({
      to: '5493415550001',
      type: 'template',
      template: {
        name: 'pedido_listo',
        language: { code: 'es_AR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Juan' },
              { type: 'text', text: '#123' },
            ],
          },
        ],
      },
    });
    // body renderizado para el hilo y preview
    expect(db.message.rows[0].body).toBe('Hola Juan! Tu pedido #123 está listo.');
    expect(db.message.rows[0].type).toBe('TEMPLATE');
  });

  it('cantidad de parámetros incorrecta → 422 TEMPLATE_INVALID sin llamar a Meta', async () => {
    seedConversation();
    seedTemplate(); // espera 2

    const outcome = await service.send(TENANT, 'conv_1', templateReq(['solo-uno']), null);
    expect(outcome.httpStatus).toBe(422);
    expect(outcome.error?.code).toBe('TEMPLATE_INVALID');
    expect(graph.sendMessage).not.toHaveBeenCalled();
    expect(db.message.rows).toHaveLength(0);
  });

  it('plantilla no aprobada → 422 TEMPLATE_INVALID', async () => {
    seedConversation();
    seedTemplate({ status: 'PENDING' });

    const outcome = await service.send(TENANT, 'conv_1', templateReq(['a', 'b']), null);
    expect(outcome.httpStatus).toBe(422);
    expect(outcome.error?.code).toBe('TEMPLATE_INVALID');
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });
});
