import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { InboundMessagesService } from '../src/webhook-worker/inbound-messages.service';
import { MessageStatusesService } from '../src/webhook-worker/message-statuses.service';
import { WebhookEventHandler } from '../src/webhook-worker/webhook-event.handler';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';
const PNID = '111222333444555';
const TS = 1_690_000_000; // epoch en segundos
const TS_MS = TS * 1000;

let db: FakeDb;
let handler: WebhookEventHandler;
let mediaQueue: { add: ReturnType<typeof vi.fn> };

function makeHandler(fake: FakeDb): WebhookEventHandler {
  const prisma = { db: fake } as unknown as PrismaService;
  return new WebhookEventHandler(
    prisma,
    new InboundMessagesService(prisma, mediaQueue as unknown as Queue),
    new MessageStatusesService(prisma),
  );
}

function seedAccount(): void {
  db.whatsappAccount.seed({
    id: 'acc_1',
    tenantId: TENANT,
    metaAppId: 'app_1',
    wabaId: 'waba_1',
    phoneNumberId: PNID,
    displayPhoneNumber: '+54 9 341 555-0000',
    status: 'ACTIVE',
  });
}

function seedEvent(payload: unknown, id = `evt_${Math.random().toString(36).slice(2)}`): string {
  db.webhookEvent.seed({ id, status: 'QUEUED', signatureValid: true, payload, receivedAt: new Date() });
  return id;
}

/** value de un change 'messages' con overrides. */
function change(value: Record<string, unknown>): Record<string, unknown> {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '+54 9 341 555-0000', phone_number_id: PNID },
      ...value,
    },
  };
}

function payloadOf(...changes: Record<string, unknown>[]): Record<string, unknown> {
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba_1', changes }] };
}

function textMessage(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    from: '5493415550001',
    id: 'wamid.IN.1',
    timestamp: String(TS),
    type: 'text',
    text: { body: 'hola, ¿tienen mesa para dos?' },
    ...over,
  };
}

const CONTACTS = [{ wa_id: '5493415550001', profile: { name: 'Juan Pérez' } }];

beforeAll(() => {
  Logger.overrideLogger(false); // sin ruido de Nest en la salida de vitest
});

beforeEach(() => {
  db = createFakeDb();
  mediaQueue = { add: vi.fn().mockResolvedValue({}) };
  handler = makeHandler(db);
  seedAccount();
});

describe('WebhookEventHandler — mensajes entrantes', () => {
  it('payload real de texto → contact + conversation + message, lastInboundAt y unreadCount correctos', async () => {
    const eventId = seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [textMessage()] })));
    await handler.handle(eventId);

    const contact = db.contact.rows[0];
    expect(contact).toMatchObject({
      tenantId: TENANT,
      waId: '5493415550001',
      phoneE164: '+5493415550001',
      profileName: 'Juan Pérez',
    });

    const conv = db.conversation.rows[0];
    expect(conv).toMatchObject({ tenantId: TENANT, status: 'OPEN', unreadCount: 1 });
    expect((conv.lastInboundAt as Date).getTime()).toBe(TS_MS);
    expect((conv.lastMessageAt as Date).getTime()).toBe(TS_MS);
    expect(conv.lastMessagePreview).toBe('hola, ¿tienen mesa para dos?');

    const msg = db.message.rows[0];
    expect(msg).toMatchObject({
      tenantId: TENANT,
      direction: 'INBOUND',
      type: 'TEXT',
      wamid: 'wamid.IN.1',
      body: 'hola, ¿tienen mesa para dos?',
      raw: null, // tipo conocido sin error → raw NO se persiste
    });
    // Conversión epoch-segundos (el bug clásico dejaría esto en 1970)
    expect((msg.timestamp as Date).getTime()).toBe(TS_MS);
    expect((msg.timestamp as Date).getUTCFullYear()).toBeGreaterThan(2020);

    const event = db.webhookEvent.rows[0];
    expect(event).toMatchObject({
      status: 'PROCESSED',
      tenantId: TENANT,
      whatsappAccountId: 'acc_1',
      phoneNumberId: PNID,
    });
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('mismo wamid dos veces (reintento de Meta) → sin duplicados y unreadCount sigue en 1', async () => {
    const p = payloadOf(change({ contacts: CONTACTS, messages: [textMessage()] }));
    await handler.handle(seedEvent(p, 'evt_a'));
    await handler.handle(seedEvent(p, 'evt_b')); // mismo payload, evento nuevo

    expect(db.message.rows).toHaveLength(1);
    expect(db.conversation.rows[0].unreadCount).toBe(1);
    expect(db.contact.rows).toHaveLength(1);

    // Y reprocesar un evento ya PROCESSED (reintento de BullMQ) tampoco duplica
    await handler.handle('evt_a');
    expect(db.message.rows).toHaveLength(1);
    expect(db.conversation.rows[0].unreadCount).toBe(1);
  });

  it('dos mensajes distintos del mismo cliente → UNA sola conversation (unique triple)', async () => {
    await handler.handle(
      seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [textMessage()] }))),
    );
    await handler.handle(
      seedEvent(
        payloadOf(
          change({
            contacts: CONTACTS,
            messages: [textMessage({ id: 'wamid.IN.2', timestamp: String(TS + 60), text: { body: 'sigo acá' } })],
          }),
        ),
      ),
    );

    expect(db.conversation.rows).toHaveLength(1);
    expect(db.message.rows).toHaveLength(2);
    expect(db.conversation.rows[0].unreadCount).toBe(2);
    expect((db.conversation.rows[0].lastInboundAt as Date).getTime()).toBe((TS + 60) * 1000);
  });

  it('mensaje con media → mediaStatus PENDING y job de descarga encolado TRAS el commit', async () => {
    const image = textMessage({
      id: 'wamid.IMG',
      type: 'image',
      text: undefined,
      image: { id: 'media_meta_1', mime_type: 'image/jpeg', sha256: 'abc' },
    });
    await handler.handle(seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [image] }))));

    const msg = db.message.rows[0];
    expect(msg).toMatchObject({ type: 'IMAGE', mediaId: 'media_meta_1', mediaStatus: 'PENDING' });
    expect(mediaQueue.add).toHaveBeenCalledWith(
      'download-media',
      { tenantId: TENANT, messageId: msg.id },
      { jobId: `media-${msg.id}` },
    );

    // reintento de Meta (mismo wamid) → NO se encola de nuevo
    await handler.handle(seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [image] }))));
    expect(mediaQueue.add).toHaveBeenCalledTimes(1);
  });

  it('tipo inventado → UNSUPPORTED con raw poblado', async () => {
    const raro = textMessage({ id: 'wamid.RARO', type: 'flight_ticket', text: undefined });
    await handler.handle(seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [raro] }))));

    const msg = db.message.rows[0];
    expect(msg.type).toBe('UNSUPPORTED');
    expect(msg.raw).not.toBeNull(); // la única situación (junto a errores) donde raw se guarda
    expect(db.conversation.rows[0].lastMessagePreview).toBe('Mensaje no soportado');
  });

  it('reaction: REACTION con emoji, sin inflar unreadCount, preview "Reaccionó 👍"', async () => {
    await handler.handle(
      seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [textMessage()] }))),
    );
    const reaction = {
      from: '5493415550001',
      id: 'wamid.REACT',
      timestamp: String(TS + 30),
      type: 'reaction',
      reaction: { message_id: 'wamid.IN.1', emoji: '👍' },
    };
    await handler.handle(seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [reaction] }))));

    const msg = db.message.rows.find((m) => m.wamid === 'wamid.REACT');
    expect(msg).toMatchObject({ type: 'REACTION', body: '👍', replyToWamid: 'wamid.IN.1' });

    const conv = db.conversation.rows[0];
    expect(conv.unreadCount).toBe(1); // la reaction NO sumó
    expect(conv.lastMessagePreview).toBe('Reaccionó 👍'); // pero SÍ pisó el preview
    expect((conv.lastInboundAt as Date).getTime()).toBe((TS + 30) * 1000); // y refresca la ventana
  });

  it('mensaje entrante reabre una conversación CLOSED', async () => {
    await handler.handle(
      seedEvent(payloadOf(change({ contacts: CONTACTS, messages: [textMessage()] }))),
    );
    db.conversation.rows[0].status = 'CLOSED';

    await handler.handle(
      seedEvent(
        payloadOf(change({ contacts: CONTACTS, messages: [textMessage({ id: 'wamid.IN.3', timestamp: String(TS + 120) })] })),
      ),
    );
    expect(db.conversation.rows[0].status).toBe('OPEN');
  });
});

describe('WebhookEventHandler — statuses', () => {
  function seedOutbound(over: Record<string, unknown> = {}): void {
    db.contact.seed({ id: 'contact_out', tenantId: TENANT, waId: '5493415550001' });
    db.conversation.seed({
      id: 'conv_out',
      tenantId: TENANT,
      whatsappAccountId: 'acc_1',
      contactId: 'contact_out',
    });
    db.message.seed({
      id: 'msg_out',
      tenantId: TENANT,
      conversationId: 'conv_out',
      whatsappAccountId: 'acc_1',
      wamid: 'wamid.OUT.1',
      direction: 'OUTBOUND',
      type: 'TEXT',
      status: 'SENT',
      timestamp: new Date(TS_MS),
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      ...over,
    });
  }

  const statusOf = (status: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'wamid.OUT.1',
    status,
    timestamp: String(TS + 10),
    recipient_id: '5493415550001',
    ...over,
  });

  it('read llegando ANTES que delivered: status = READ y el delivered tardío solo sella deliveredAt', async () => {
    seedOutbound();
    await handler.handle(seedEvent(payloadOf(change({ statuses: [statusOf('read', { timestamp: String(TS + 20) })] }))));

    let msg = db.message.rows.find((m) => m.wamid === 'wamid.OUT.1')!;
    expect(msg.status).toBe('READ');
    expect((msg.readAt as Date).getTime()).toBe((TS + 20) * 1000);
    expect(msg.deliveredAt).toBeNull();

    // delivered tardío
    await handler.handle(seedEvent(payloadOf(change({ statuses: [statusOf('delivered', { timestamp: String(TS + 15) })] }))));
    msg = db.message.rows.find((m) => m.wamid === 'wamid.OUT.1')!;
    expect(msg.status).toBe('READ'); // NO retrocede
    expect((msg.deliveredAt as Date).getTime()).toBe((TS + 15) * 1000); // pero sella su timestamp
  });

  it('pricing en sent se mapea; delivered posterior sin pricing NO pisa con null', async () => {
    seedOutbound({ status: 'PENDING' });
    await handler.handle(
      seedEvent(
        payloadOf(
          change({
            statuses: [
              statusOf('sent', {
                pricing: { billable: true, pricing_model: 'PMP', category: 'service', type: 'regular' },
              }),
            ],
          }),
        ),
      ),
    );

    let msg = db.message.rows.find((m) => m.wamid === 'wamid.OUT.1')!;
    expect(msg).toMatchObject({
      status: 'SENT',
      billable: true,
      pricingModel: 'PMP',
      pricingCategory: 'service',
      pricingType: 'regular',
    });

    await handler.handle(seedEvent(payloadOf(change({ statuses: [statusOf('delivered')] }))));
    msg = db.message.rows.find((m) => m.wamid === 'wamid.OUT.1')!;
    expect(msg).toMatchObject({
      status: 'DELIVERED',
      billable: true, // intacto
      pricingCategory: 'service',
    });
  });

  it('failed es terminal: pisa el estado y sella failedAt + error de errors[]', async () => {
    seedOutbound({ status: 'DELIVERED', deliveredAt: new Date(TS_MS) });
    await handler.handle(
      seedEvent(
        payloadOf(
          change({
            statuses: [
              statusOf('failed', {
                errors: [
                  {
                    code: 131047,
                    title: 'Re-engagement message',
                    error_data: { details: 'Ventana de 24h cerrada' },
                  },
                ],
              }),
            ],
          }),
        ),
      ),
    );

    const msg = db.message.rows.find((m) => m.wamid === 'wamid.OUT.1')!;
    expect(msg).toMatchObject({
      status: 'FAILED',
      errorCode: 131047,
      errorTitle: 'Re-engagement message',
      errorDetail: 'Ventana de 24h cerrada',
    });
    expect((msg.failedAt as Date).getTime()).toBe((TS + 10) * 1000);
  });

  it('status confirmado de un saliente actualiza Conversation.lastOutboundAt', async () => {
    seedOutbound();
    await handler.handle(seedEvent(payloadOf(change({ statuses: [statusOf('delivered')] }))));
    const conv = db.conversation.rows.find((c) => c.id === 'conv_out')!;
    expect((conv.lastOutboundAt as Date).getTime()).toBe(TS_MS); // timestamp del mensaje
  });

  it('status de un wamid desconocido → no explota y el evento queda PROCESSED', async () => {
    const eventId = seedEvent(
      payloadOf(change({ statuses: [statusOf('delivered', { id: 'wamid.FANTASMA' })] })),
    );
    await expect(handler.handle(eventId)).resolves.toBeUndefined();
    expect(db.webhookEvent.rows[0].status).toBe('PROCESSED');
  });
});

describe('WebhookEventHandler — resolución y estructura', () => {
  it('messages[] y statuses[] mezclados en múltiples entries → todo procesado', async () => {
    db.contact.seed({ id: 'contact_out', tenantId: TENANT, waId: '5493415550001' });
    db.conversation.seed({
      id: 'conv_out',
      tenantId: TENANT,
      whatsappAccountId: 'acc_1',
      contactId: 'contact_out',
    });
    db.message.seed({
      id: 'msg_out',
      tenantId: TENANT,
      conversationId: 'conv_out',
      whatsappAccountId: 'acc_1',
      wamid: 'wamid.OUT.1',
      direction: 'OUTBOUND',
      type: 'TEXT',
      status: 'SENT',
      timestamp: new Date(TS_MS),
    });

    const eventId = seedEvent({
      object: 'whatsapp_business_account',
      entry: [
        { id: 'waba_1', changes: [change({ contacts: CONTACTS, messages: [textMessage()] })] },
        {
          id: 'waba_1',
          changes: [
            change({
              statuses: [{ id: 'wamid.OUT.1', status: 'read', timestamp: String(TS + 5) }],
            }),
          ],
        },
      ],
    });
    await handler.handle(eventId);

    expect(db.message.rows.find((m) => m.wamid === 'wamid.IN.1')).toBeTruthy(); // mensaje procesado
    expect(db.message.rows.find((m) => m.wamid === 'wamid.OUT.1')!.status).toBe('READ'); // status procesado
    expect(db.webhookEvent.rows[0].status).toBe('PROCESSED');
  });

  it('phone_number_id desconocido → evento DISCARDED con motivo, job OK sin throw', async () => {
    const eventId = seedEvent(
      payloadOf({
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'PNID-QUE-NO-EXISTE' },
          messages: [textMessage()],
        },
      }),
    );
    await expect(handler.handle(eventId)).resolves.toBeUndefined();

    const event = db.webhookEvent.rows[0];
    expect(event.status).toBe('DISCARDED');
    expect(event.error).toContain('PNID-QUE-NO-EXISTE');
    expect(db.message.rows).toHaveLength(0);
  });

  it('payload sin entry parseable → DISCARDED', async () => {
    const eventId = seedEvent('{esto llegó como string porque no era JSON');
    await handler.handle(eventId);
    expect(db.webhookEvent.rows[0].status).toBe('DISCARDED');
  });

  it('evento inexistente → job OK sin throw', async () => {
    await expect(handler.handle('evt_fantasma')).resolves.toBeUndefined();
  });
});
