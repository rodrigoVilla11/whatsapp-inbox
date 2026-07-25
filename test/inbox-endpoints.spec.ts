import 'reflect-metadata';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeConversation, serializeMessage } from '../src/common/serializers';
import { ConversationsService } from '../src/inbox/conversations.service';
import { QuickRepliesService } from '../src/inbox/quick-replies.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';
const NOW = Date.now();

let db: FakeDb;
let graph: { markMessageRead: ReturnType<typeof vi.fn> };
let events: { publish: ReturnType<typeof vi.fn> };
let service: ConversationsService;
let quickReplies: QuickRepliesService;

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  db = createFakeDb();
  graph = { markMessageRead: vi.fn().mockResolvedValue(undefined) };
  events = { publish: vi.fn().mockResolvedValue(undefined) };
  const prisma = { db } as unknown as PrismaService;
  service = new ConversationsService(prisma, graph as unknown as GraphApiClient, events);
  quickReplies = new QuickRepliesService(prisma);

  db.tenant.seed({ id: TENANT, slug: 'nova-sushi', name: 'Nova Sushi' });
  db.whatsappAccount.seed({ id: 'acc_1', tenantId: TENANT, phoneNumberId: 'PN_1' });
});

function seedConversation(id: string, over: Record<string, unknown> = {}): void {
  const contactId = `contact_${id}`;
  db.contact.seed({ id: contactId, tenantId: TENANT, waId: `549341${id}`, profileName: `Cliente ${id}` });
  db.conversation.seed({
    id,
    tenantId: TENANT,
    whatsappAccountId: 'acc_1',
    contactId,
    lastMessageAt: new Date(NOW),
    lastInboundAt: new Date(NOW),
    ...over,
  });
}

describe('serializadores (contrato REST + WS)', () => {
  it('Message excluye raw/mediaUrl/pricing/tenantId y conserva lo visible', () => {
    db.message.seed({
      id: 'm1', tenantId: TENANT, conversationId: 'c1', whatsappAccountId: 'acc_1',
      direction: 'INBOUND', type: 'TEXT', body: 'hola', wamid: 'wamid.1',
      raw: { secreto: true }, mediaUrl: 'ten_1/c1/m1/x.jpg', billable: true,
      pricingCategory: 'service', timestamp: new Date(NOW),
    });
    const dto = serializeMessage(db.message.rows[0] as never) as Record<string, unknown>;
    expect(dto).toMatchObject({ id: 'm1', body: 'hola', wamid: 'wamid.1' });
    expect(dto).not.toHaveProperty('raw');
    expect(dto).not.toHaveProperty('mediaUrl');
    expect(dto).not.toHaveProperty('billable');
    expect(dto).not.toHaveProperty('pricingCategory');
    expect(dto).not.toHaveProperty('tenantId');
  });

  it('Conversation incluye isWindowOpen y windowExpiresAt calculados por el server', () => {
    seedConversation('c_ser', { lastInboundAt: new Date(NOW - 23 * 3600 * 1000) });
    const dto = serializeConversation(db.conversation.rows[0] as never) as Record<string, unknown>;
    expect(dto.isWindowOpen).toBe(true);
    expect(typeof dto.windowExpiresAt).toBe('string');
    expect(new Date(dto.windowExpiresAt as string).getTime()).toBe(NOW + 3600 * 1000);
  });
});

describe('GET /conversations', () => {
  it('filtro default OPEN+PENDING, orden lastMessageAt desc, contacto embebido', async () => {
    seedConversation('c_vieja', { lastMessageAt: new Date(NOW - 3000) });
    seedConversation('c_nueva', { lastMessageAt: new Date(NOW - 1000) });
    seedConversation('c_pending', { status: 'PENDING', lastMessageAt: new Date(NOW - 2000) });
    seedConversation('c_cerrada', { status: 'CLOSED', lastMessageAt: new Date(NOW) });

    const result = await service.list(TENANT, null, {});
    const ids = (result.conversations as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(['c_nueva', 'c_pending', 'c_vieja']); // CLOSED afuera
    expect(result.timezone).toBe('America/Argentina/Buenos_Aires');
    const first = result.conversations[0] as { contact: { profileName: string }; isWindowOpen: boolean };
    expect(first.contact.profileName).toBe('Cliente c_nueva');
    expect(typeof first.isWindowOpen).toBe('boolean');
  });

  it('cursor: pagina de a 30 sin repetir ni saltear', async () => {
    for (let i = 0; i < 35; i++) {
      seedConversation(`c_${String(i).padStart(2, '0')}`, {
        lastMessageAt: new Date(NOW - i * 1000),
      });
    }
    const page1 = await service.list(TENANT, null, {});
    expect(page1.conversations).toHaveLength(30);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await service.list(TENANT, null, { cursor: page1.nextCursor! });
    expect(page2.conversations).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.conversations, ...page2.conversations] as Array<{ id: string }>;
    expect(new Set(all.map((c) => c.id)).size).toBe(35); // sin duplicados
  });

  it('assignedToMe filtra por el usuario del contexto', async () => {
    db.user.seed({ id: 'user_yo', tenantId: TENANT, email: 'yo@x.com', name: 'Yo' });
    seedConversation('c_mia', { assignedUserId: 'user_yo' });
    seedConversation('c_ajena', { assignedUserId: 'user_otro' });
    seedConversation('c_libre');

    const result = await service.list(TENANT, 'user_yo', { assignedToMe: true });
    expect((result.conversations as Array<{ id: string }>).map((c) => c.id)).toEqual(['c_mia']);
  });
});

describe('GET /conversations/:id/messages', () => {
  it('cursor por timestamp desc, 50 por página, serializados', async () => {
    seedConversation('c_msgs');
    for (let i = 0; i < 55; i++) {
      db.message.seed({
        id: `m_${String(i).padStart(2, '0')}`, tenantId: TENANT, conversationId: 'c_msgs',
        whatsappAccountId: 'acc_1', direction: 'INBOUND', type: 'TEXT', body: `msg ${i}`,
        raw: { x: 1 }, timestamp: new Date(NOW - i * 1000),
      });
    }
    const page1 = await service.listMessages(TENANT, 'c_msgs');
    expect(page1.messages).toHaveLength(50);
    expect((page1.messages[0] as { body: string }).body).toBe('msg 0'); // más nuevo primero
    expect(page1.messages[0]).not.toHaveProperty('raw');

    const page2 = await service.listMessages(TENANT, 'c_msgs', page1.nextCursor!);
    expect(page2.messages).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
  });

  it('conversación inexistente → 404', async () => {
    await expect(service.listMessages(TENANT, 'nope')).rejects.toThrow(NotFoundException);
  });
});

describe('POST read / assign / status', () => {
  it('read: unreadCount→0, emite conversation.updated, y mark-read a Meta best-effort', async () => {
    seedConversation('c_read', { unreadCount: 4 });
    db.message.seed({
      id: 'm_in', tenantId: TENANT, conversationId: 'c_read', whatsappAccountId: 'acc_1',
      direction: 'INBOUND', type: 'TEXT', wamid: 'wamid.LAST', timestamp: new Date(NOW),
    });

    const dto = (await service.markRead(TENANT, 'c_read')) as { unreadCount: number };
    expect(dto.unreadCount).toBe(0);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'conversation.updated', tenantId: TENANT }),
    );
    await new Promise((r) => setTimeout(r, 0)); // el mark-read corre fire-and-forget
    expect(graph.markMessageRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc_1' }),
      'wamid.LAST',
    );
  });

  it('read: si Meta falla, el endpoint NO falla', async () => {
    graph.markMessageRead.mockRejectedValueOnce(new Error('meta caída'));
    seedConversation('c_read2', { unreadCount: 1 });
    db.message.seed({
      id: 'm_in2', tenantId: TENANT, conversationId: 'c_read2', whatsappAccountId: 'acc_1',
      direction: 'INBOUND', type: 'TEXT', wamid: 'wamid.X', timestamp: new Date(NOW),
    });
    const dto = (await service.markRead(TENANT, 'c_read2')) as { unreadCount: number };
    expect(dto.unreadCount).toBe(0); // best-effort de verdad
  });

  it('assign valida que el usuario sea del tenant; null libera', async () => {
    db.user.seed({ id: 'user_ok', tenantId: TENANT, email: 'a@x.com', name: 'A' });
    db.user.seed({ id: 'user_otro_tenant', tenantId: 'ten_2', email: 'b@x.com', name: 'B' });
    seedConversation('c_asig');

    const assigned = (await service.assign(TENANT, 'c_asig', 'user_ok')) as {
      assignedUserId: string;
    };
    expect(assigned.assignedUserId).toBe('user_ok');
    expect(events.publish).toHaveBeenCalled();

    await expect(service.assign(TENANT, 'c_asig', 'user_otro_tenant')).rejects.toThrow(
      BadRequestException,
    );

    const released = (await service.assign(TENANT, 'c_asig', null)) as {
      assignedUserId: string | null;
    };
    expect(released.assignedUserId).toBeNull();
  });

  it('status OPEN↔CLOSED emite conversation.updated', async () => {
    seedConversation('c_st');
    const closed = (await service.setStatus(TENANT, 'c_st', 'CLOSED')) as { status: string };
    expect(closed.status).toBe('CLOSED');
    expect(
      events.publish.mock.calls.filter((c) => c[0].type === 'conversation.updated'),
    ).toHaveLength(1);
  });
});

describe('QuickReplies CRUD', () => {
  it('crea validando shortcut con / y unicidad por tenant', async () => {
    await quickReplies.create(TENANT, { shortcut: '/carta', title: 'Carta', body: 'link' });
    await expect(
      quickReplies.create(TENANT, { shortcut: 'carta', title: 'x', body: 'y' }),
    ).rejects.toThrow(/empezar con/);
    await expect(
      quickReplies.create(TENANT, { shortcut: '/carta', title: 'dup', body: 'z' }),
    ).rejects.toThrow(/ya existe/);
  });

  it('lista solo activas por default; delete es soft (isActive false)', async () => {
    const created = (await quickReplies.create(TENANT, {
      shortcut: '/horario', title: 'Horario', body: '19 a 24',
    })) as { id: string };

    await quickReplies.deactivate(TENANT, created.id);
    expect(await quickReplies.list(TENANT)).toHaveLength(0);
    expect(await quickReplies.list(TENANT, true)).toHaveLength(1); // sigue existiendo
    expect(db.quickReply.rows[0].isActive).toBe(false);
  });

  it('update parcial revalida shortcut y respeta el scope del tenant', async () => {
    const created = (await quickReplies.create(TENANT, {
      shortcut: '/promo', title: 'Promo', body: '2x1',
    })) as { id: string };
    const updated = (await quickReplies.update(TENANT, created.id, { body: '3x2' })) as {
      body: string;
    };
    expect(updated.body).toBe('3x2');
    await expect(
      quickReplies.update(TENANT, created.id, { shortcut: 'sin-barra' }),
    ).rejects.toThrow(/empezar con/);
    await expect(quickReplies.update('otro_tenant', created.id, { body: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });
});
