import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsService } from '../src/auth/sessions.service';
import { UsersService } from '../src/auth/users.service';
import { ConversationsService } from '../src/inbox/conversations.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';

/** Fase 9c: GET /conversations?q=, GET /users, PATCH /contacts/:id (notes). */

const TENANT = 'ten_1';
const OTRO_TENANT = 'ten_2';
const NOW = Date.now();

let db: FakeDb;
let service: ConversationsService;
let usersService: UsersService;

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  db = createFakeDb();
  const prisma = { db } as unknown as PrismaService;
  service = new ConversationsService(
    prisma,
    { markMessageRead: vi.fn() } as unknown as GraphApiClient,
    { publish: vi.fn().mockResolvedValue(undefined) },
  );
  usersService = new UsersService(prisma, new SessionsService(prisma));
  db.tenant.seed({ id: TENANT, slug: 'nova-sushi', name: 'Nova Sushi' });
  db.tenant.seed({ id: OTRO_TENANT, slug: 'otro', name: 'Otro' });
  db.whatsappAccount.seed({ id: 'acc_1', tenantId: TENANT, phoneNumberId: 'PN_1' });
});

function seedContactAndConversation(
  id: string,
  contact: Record<string, unknown>,
  conversation: Record<string, unknown> = {},
): void {
  const tenantId = (contact.tenantId as string) ?? TENANT;
  db.contact.seed({ id: `ct_${id}`, tenantId, waId: `54934100${id}`, ...contact });
  db.conversation.seed({
    id,
    tenantId,
    whatsappAccountId: 'acc_1',
    contactId: `ct_${id}`,
    lastMessageAt: new Date(NOW),
    lastInboundAt: new Date(NOW),
    ...conversation,
  });
}

describe('GET /conversations?q=', () => {
  it('busca por nombre, insensible a mayúsculas y parcial', async () => {
    seedContactAndConversation('c_maria', { profileName: 'María González' });
    seedContactAndConversation('c_juan', { profileName: 'Juan Pérez' });

    const result = await service.list(TENANT, null, { q: 'maRÍa' });
    expect((result.conversations as Array<{ id: string }>).map((c) => c.id)).toEqual(['c_maria']);
  });

  it('busca por teléfono normalizando el q ("+54 9 341-1" matchea waId/phoneE164)', async () => {
    seedContactAndConversation('c_tel', {
      profileName: null,
      waId: '5493411234567',
      phoneE164: '+5493411234567',
    });
    seedContactAndConversation('c_otro_tel', { waId: '5491199999999' });

    const result = await service.list(TENANT, null, { q: '+54 9 341-123' });
    expect((result.conversations as Array<{ id: string }>).map((c) => c.id)).toEqual(['c_tel']);
  });

  it('con q cruza TODOS los estados (una cerrada también aparece)', async () => {
    seedContactAndConversation('c_cerrada', { profileName: 'Ana Cerrada' }, { status: 'CLOSED' });

    const sinBusqueda = await service.list(TENANT, null, {});
    expect(sinBusqueda.conversations).toHaveLength(0); // el default excluye CLOSED

    const result = await service.list(TENANT, null, { q: 'ana' });
    expect((result.conversations as Array<{ id: string }>).map((c) => c.id)).toEqual(['c_cerrada']);
  });

  it('sin resultados devuelve página vacía con timezone (no 404)', async () => {
    const result = await service.list(TENANT, null, { q: 'nadie' });
    expect(result.conversations).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  it('tenant-scoping: no encuentra contactos de otro tenant', async () => {
    seedContactAndConversation('c_ajena', { tenantId: OTRO_TENANT, profileName: 'María Ajena' });
    const result = await service.list(TENANT, null, { q: 'maría' });
    expect(result.conversations).toEqual([]);
  });
});

describe('GET /users', () => {
  it('lista solo usuarios activos del tenant, ordenados por nombre', async () => {
    db.user.seed({ id: 'u_b', tenantId: TENANT, email: 'b@x.com', name: 'Berta' });
    db.user.seed({ id: 'u_a', tenantId: TENANT, email: 'a@x.com', name: 'Alfredo' });
    db.user.seed({ id: 'u_off', tenantId: TENANT, email: 'off@x.com', name: 'Baja', isActive: false });
    db.user.seed({ id: 'u_ajeno', tenantId: OTRO_TENANT, email: 'c@x.com', name: 'Ajeno' });

    const users = (await usersService.listForAssignment(TENANT)) as Array<{
      id: string;
      name: string;
    }>;
    expect(users.map((u) => u.id)).toEqual(['u_a', 'u_b']);
    // DTO mínimo: sin email ni passwordHash
    expect(users[0]).toEqual({ id: 'u_a', name: 'Alfredo', role: 'AGENT' });
  });
});

describe('PATCH /contacts/:id (notes)', () => {
  it('actualiza SOLO notes y devuelve el contacto serializado', async () => {
    db.contact.seed({
      id: 'ct_n', tenantId: TENANT, waId: '549341', profileName: 'María', isBlocked: false,
    });
    const dto = (await service.updateContactNotes(TENANT, 'ct_n', 'pide sin wasabi')) as {
      notes: string;
      profileName: string;
    };
    expect(dto.notes).toBe('pide sin wasabi');
    expect(dto.profileName).toBe('María'); // el resto queda intacto
    expect(dto).not.toHaveProperty('tenantId');
  });

  it("'' o espacios se guardan como null (nota borrada, no nota vacía)", async () => {
    db.contact.seed({ id: 'ct_v', tenantId: TENANT, waId: '549342', notes: 'vieja' });
    const dto = (await service.updateContactNotes(TENANT, 'ct_v', '   ')) as { notes: null };
    expect(dto.notes).toBeNull();
  });

  it('tenant-scoping: contacto de otro tenant → 404', async () => {
    db.contact.seed({ id: 'ct_ajeno', tenantId: OTRO_TENANT, waId: '549343' });
    await expect(service.updateContactNotes(TENANT, 'ct_ajeno', 'x')).rejects.toThrow(
      NotFoundException,
    );
  });
});
