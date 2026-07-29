import 'reflect-metadata';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationsService } from '../src/inbox/conversations.service';
import { tagSlug } from '../src/inbox/tag-colors';
import { TagsService } from '../src/inbox/tags.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';

/**
 * Anclado compartido + etiquetas: orden de la lista, filtro y búsqueda.
 *
 * Lo delicado acá es la interacción entre los anclados y el cursor keyset:
 * los anclados NO paginan (van arriba de la primera página) y el cursor
 * corre sobre los NO-anclados. Cada regla de eso tiene su test.
 */

const TENANT = 'ten_1';
const OTRO = 'ten_2';
const NOW = Date.now();
const MIN = 60_000;

let db: FakeDb;
let tags: TagsService;
let service: ConversationsService;

beforeAll(() => Logger.overrideLogger(false));

beforeEach(() => {
  db = createFakeDb();
  const prisma = { db } as unknown as PrismaService;
  tags = new TagsService(prisma);
  service = new ConversationsService(
    prisma,
    { markMessageRead: vi.fn() } as unknown as GraphApiClient,
    tags,
    { publish: vi.fn().mockResolvedValue(undefined) },
  );
  db.tenant.seed({ id: TENANT, slug: 'nova-sushi', name: 'Nova Sushi' });
  db.tenant.seed({ id: OTRO, slug: 'otro', name: 'Otro' });
  db.whatsappAccount.seed({ id: 'acc_1', tenantId: TENANT, phoneNumberId: 'PN_1' });
});

function seedConversation(
  id: string,
  minutesAgo: number,
  over: Record<string, unknown> = {},
): void {
  const contactId = `contact_${id}`;
  db.contact.seed({
    id: contactId,
    tenantId: TENANT,
    waId: `54934100${id}`,
    profileName: `Cliente ${id}`,
  });
  db.conversation.seed({
    id,
    tenantId: TENANT,
    whatsappAccountId: 'acc_1',
    contactId,
    lastMessageAt: new Date(NOW - minutesAgo * MIN),
    lastInboundAt: new Date(NOW - minutesAgo * MIN),
    ...over,
  });
}

const ids = (result: { conversations: unknown[] }): string[] =>
  result.conversations.map((c) => (c as { id: string }).id);

// ── Anclado ───────────────────────────────────────────────────────────────

describe('anclado compartido', () => {
  it('el anclado va PRIMERO aunque su último mensaje sea el más viejo', async () => {
    seedConversation('nueva', 1);
    seedConversation('media', 30);
    seedConversation('vieja', 500);

    expect(ids(await service.list(TENANT, null, {}))).toEqual(['nueva', 'media', 'vieja']);

    await service.setPinned(TENANT, 'vieja', true);
    expect(ids(await service.list(TENANT, null, {}))).toEqual(['vieja', 'nueva', 'media']);
  });

  it('desanclar devuelve el orden por fecha', async () => {
    seedConversation('a', 1);
    seedConversation('b', 100);
    await service.setPinned(TENANT, 'b', true);
    expect(ids(await service.list(TENANT, null, {}))).toEqual(['b', 'a']);

    await service.setPinned(TENANT, 'b', false);
    expect(ids(await service.list(TENANT, null, {}))).toEqual(['a', 'b']);
  });

  it('entre varios anclados, el ÚLTIMO anclado va primero', async () => {
    seedConversation('a', 10);
    seedConversation('b', 20);
    seedConversation('c', 30);

    await service.setPinned(TENANT, 'a', true);
    await new Promise((r) => setTimeout(r, 2)); // pinnedAt distinto
    await service.setPinned(TENANT, 'c', true);

    expect(ids(await service.list(TENANT, null, {}))).toEqual(['c', 'a', 'b']);
  });

  it('el anclado NO se escapa del filtro: una CERRADA anclada no aparece en "abiertas"', async () => {
    seedConversation('abierta', 5);
    seedConversation('cerrada', 5, { status: 'CLOSED' });
    await service.setPinned(TENANT, 'cerrada', true);

    expect(ids(await service.list(TENANT, null, { filter: 'open' }))).toEqual(['abierta']);
    expect(ids(await service.list(TENANT, null, { filter: 'closed' }))).toEqual(['cerrada']);
  });

  it('el anclado NO se cuela en resultados de búsqueda que no matchean', async () => {
    seedConversation('maria', 5);
    db.contact.updateMany({
      where: { id: 'contact_maria' },
      data: { profileName: 'María' },
    });
    seedConversation('pedro', 5);
    await service.setPinned(TENANT, 'pedro', true);

    // "María" no debe traer a Pedro solo por estar anclado
    expect(ids(await service.list(TENANT, null, { q: 'mar' }))).toEqual(['maria']);
  });

  it('con cursor (2da página) los anclados NO se repiten arriba', async () => {
    for (let i = 0; i < 35; i++) seedConversation(`c${String(i).padStart(2, '0')}`, i + 1);
    await service.setPinned(TENANT, 'c30', true);

    const first = await service.list(TENANT, null, {});
    expect(ids(first)[0]).toBe('c30');
    expect(first.nextCursor).not.toBeNull();

    const second = await service.list(TENANT, null, { cursor: first.nextCursor as string });
    expect(ids(second)).not.toContain('c30'); // ni repetido ni reinyectado
    // Sin solapamiento entre páginas
    expect(ids(second).filter((id) => ids(first).includes(id))).toEqual([]);
  });

  it('"por vencer" NO separa anclados: una anclada por vencer sigue apareciendo', async () => {
    // lastInboundAt entre 22 y 24h atrás = por vencer
    seedConversation('urgente', 23 * 60);
    seedConversation('otra', 23 * 60 + 30);
    await service.setPinned(TENANT, 'urgente', true);

    const result = await service.list(TENANT, null, { filter: 'expiring' });
    // ordena por urgencia (la más cerca de vencer primero), sin prepend
    expect(ids(result)).toEqual(['otra', 'urgente']);
  });

  it('setPinned sobre una conversación de otro tenant → 404', async () => {
    await expect(service.setPinned(OTRO, 'inexistente', true)).rejects.toThrow(NotFoundException);
  });
});

// ── Etiquetas: normalización y creación ───────────────────────────────────

describe('TagsService.create', () => {
  it('normaliza el slug: acentos, mayúsculas y espacios', () => {
    expect(tagSlug('Mayorista')).toBe('mayorista');
    expect(tagSlug('  MAYORISTA ')).toBe('mayorista');
    expect(tagSlug('Reclamó')).toBe('reclamo');
    expect(tagSlug('Sin Gluten')).toBe('sin-gluten');
    expect(tagSlug('Ñoquis')).toBe('noquis');
  });

  it('crear una que ya existe (otra capitalización) devuelve LA MISMA, no un error', async () => {
    const first = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    const second = (await tags.create(TENANT, { name: '  mayorista ' })) as { id: string };
    expect(second.id).toBe(first.id);
    expect(db.tag.rows).toHaveLength(1);
  });

  it('nombre vacío o solo símbolos → 400', async () => {
    await expect(tags.create(TENANT, { name: '   ' })).rejects.toThrow(BadRequestException);
    await expect(tags.create(TENANT, { name: '!!!' })).rejects.toThrow(BadRequestException);
  });

  it('color inválido → 400; sin color → piedra', async () => {
    await expect(tags.create(TENANT, { name: 'x', color: 'gari' })).rejects.toThrow(
      BadRequestException,
    );
    const tag = (await tags.create(TENANT, { name: 'y' })) as { color: string };
    expect(tag.color).toBe('piedra');
  });

  it('el mismo nombre en OTRO tenant es otra etiqueta', async () => {
    await tags.create(TENANT, { name: 'Mayorista' });
    await tags.create(OTRO, { name: 'Mayorista' });
    expect(db.tag.rows).toHaveLength(2);
  });
});

describe('TagsService.update / remove', () => {
  it('renombrar a una que ya existe → 400 (no fusiona en silencio)', async () => {
    const a = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    await tags.create(TENANT, { name: 'Reclamo' });
    await expect(tags.update(TENANT, a.id, { name: 'reclamo' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('renombrar recalcula el slug', async () => {
    const t = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    const updated = (await tags.update(TENANT, t.id, { name: 'Sin Gluten' })) as {
      slug: string;
      name: string;
    };
    expect(updated).toMatchObject({ name: 'Sin Gluten', slug: 'sin-gluten' });
  });

  it('etiqueta de otro tenant es invisible para update y remove', async () => {
    const t = (await tags.create(OTRO, { name: 'Ajena' })) as { id: string };
    await expect(tags.update(TENANT, t.id, { name: 'x' })).rejects.toThrow(NotFoundException);
    await expect(tags.remove(TENANT, t.id)).rejects.toThrow(NotFoundException);
  });
});

// ── Etiquetas sobre conversaciones ────────────────────────────────────────

describe('etiquetas de una conversación', () => {
  it('setForConversation reemplaza el juego completo (es idempotente)', async () => {
    seedConversation('c1', 5);
    const a = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    const b = (await tags.create(TENANT, { name: 'Reclamo' })) as { id: string };

    await tags.setForConversation(TENANT, 'c1', [a.id, b.id]);
    expect(db.conversationTag.rows).toHaveLength(2);

    // repetir el mismo set no duplica
    await tags.setForConversation(TENANT, 'c1', [a.id, b.id]);
    expect(db.conversationTag.rows).toHaveLength(2);

    // quedarse con una saca la otra
    await tags.setForConversation(TENANT, 'c1', [b.id]);
    expect(db.conversationTag.rows.map((r) => r.tagId)).toEqual([b.id]);

    // vaciar las saca todas
    await tags.setForConversation(TENANT, 'c1', []);
    expect(db.conversationTag.rows).toHaveLength(0);
  });

  it('una etiqueta de otro tenant → 400 (no cruza tenants)', async () => {
    seedConversation('c1', 5);
    const ajena = (await tags.create(OTRO, { name: 'Ajena' })) as { id: string };
    await expect(tags.setForConversation(TENANT, 'c1', [ajena.id])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('más de 6 etiquetas → 400', async () => {
    seedConversation('c1', 5);
    const created = [];
    for (let i = 0; i < 7; i++) {
      created.push((await tags.create(TENANT, { name: `t${i}` })) as { id: string });
    }
    await expect(
      tags.setForConversation(TENANT, 'c1', created.map((t) => t.id)),
    ).rejects.toThrow(BadRequestException);
  });

  it('el listado embebe las etiquetas de cada conversación', async () => {
    seedConversation('c1', 5);
    seedConversation('c2', 6);
    const a = (await tags.create(TENANT, { name: 'Mayorista', color: 'nori' })) as { id: string };
    await tags.setForConversation(TENANT, 'c1', [a.id]);

    const result = await service.list(TENANT, null, {});
    const byId = new Map(
      result.conversations.map((c) => [(c as { id: string }).id, c as Record<string, unknown>]),
    );
    expect(byId.get('c1')?.tags).toEqual([
      { id: a.id, name: 'Mayorista', slug: 'mayorista', color: 'nori' },
    ]);
    expect(byId.get('c2')?.tags).toEqual([]);
  });
});

// ── Filtro y búsqueda por etiqueta ────────────────────────────────────────

describe('filtrar por etiqueta', () => {
  it('tagIds filtra, y con varias es OR', async () => {
    seedConversation('may', 5);
    seedConversation('rec', 6);
    seedConversation('sin', 7);
    const may = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    const rec = (await tags.create(TENANT, { name: 'Reclamo' })) as { id: string };
    await tags.setForConversation(TENANT, 'may', [may.id]);
    await tags.setForConversation(TENANT, 'rec', [rec.id]);

    expect(ids(await service.list(TENANT, null, { tagIds: [may.id] }))).toEqual(['may']);
    expect(ids(await service.list(TENANT, null, { tagIds: [may.id, rec.id] }))).toEqual([
      'may',
      'rec',
    ]);
  });

  it('el filtro por etiqueta se combina con el anclado (anclada primero)', async () => {
    seedConversation('reciente', 1);
    seedConversation('vieja', 900);
    const t = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    await tags.setForConversation(TENANT, 'reciente', [t.id]);
    await tags.setForConversation(TENANT, 'vieja', [t.id]);
    await service.setPinned(TENANT, 'vieja', true);

    expect(ids(await service.list(TENANT, null, { tagIds: [t.id] }))).toEqual([
      'vieja',
      'reciente',
    ]);
  });
});

describe('buscar por coincidencia de etiqueta', () => {
  it('la búsqueda encuentra por NOMBRE de etiqueta, no solo por contacto', async () => {
    seedConversation('c1', 5);
    const t = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    await tags.setForConversation(TENANT, 'c1', [t.id]);

    expect(ids(await service.list(TENANT, null, { q: 'mayor' }))).toEqual(['c1']);
    // insensible a acentos y capitalización, igual que el slug
    expect(ids(await service.list(TENANT, null, { q: 'MAYORISTA' }))).toEqual(['c1']);
  });

  it('une los resultados por contacto Y por etiqueta', async () => {
    seedConversation('porNombre', 5);
    db.contact.updateMany({
      where: { id: 'contact_porNombre' },
      data: { profileName: 'Mayorista Central' },
    });
    seedConversation('porEtiqueta', 6);
    const t = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    await tags.setForConversation(TENANT, 'porEtiqueta', [t.id]);

    const found = ids(await service.list(TENANT, null, { q: 'mayorista' }));
    expect(found.sort()).toEqual(['porEtiqueta', 'porNombre']);
  });

  it('una etiqueta que no matchea nada y ningún contacto → lista vacía', async () => {
    seedConversation('c1', 5);
    const result = await service.list(TENANT, null, { q: 'zzzz-no-existe' });
    expect(result.conversations).toEqual([]);
    expect(result.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  it('la búsqueda por etiqueta cruza estados (encuentra cerradas)', async () => {
    seedConversation('cerrada', 5, { status: 'CLOSED' });
    const t = (await tags.create(TENANT, { name: 'Reclamo' })) as { id: string };
    await tags.setForConversation(TENANT, 'cerrada', [t.id]);

    expect(ids(await service.list(TENANT, null, { q: 'reclamo' }))).toEqual(['cerrada']);
  });
});

describe('TagsService.list', () => {
  it('trae las etiquetas del tenant con su cantidad de uso', async () => {
    seedConversation('c1', 5);
    seedConversation('c2', 6);
    const may = (await tags.create(TENANT, { name: 'Mayorista' })) as { id: string };
    const rec = (await tags.create(TENANT, { name: 'Reclamo' })) as { id: string };
    await tags.setForConversation(TENANT, 'c1', [may.id]);
    await tags.setForConversation(TENANT, 'c2', [may.id, rec.id]);

    const list = (await tags.list(TENANT)) as Array<{ name: string; usageCount: number }>;
    expect(list).toEqual([
      expect.objectContaining({ name: 'Mayorista', usageCount: 2 }),
      expect.objectContaining({ name: 'Reclamo', usageCount: 1 }),
    ]);
  });

  it('no ve las de otro tenant', async () => {
    await tags.create(OTRO, { name: 'Ajena' });
    expect(await tags.list(TENANT)).toEqual([]);
  });
});
