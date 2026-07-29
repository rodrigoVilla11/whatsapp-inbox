import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Tag } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_TAG_COLOR,
  isTagColor,
  TAG_COLORS,
  TAG_NAME_MAX,
  tagSlug,
} from './tag-colors';

/** Tope por conversación: más que esto y la fila deja de leerse. */
export const MAX_TAGS_PER_CONVERSATION = 6;

export function serializeTag(tag: Tag, usageCount?: number): Record<string, unknown> {
  return {
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    color: tag.color,
    ...(usageCount !== undefined ? { usageCount } : {}),
  };
}

/**
 * Etiquetas de conversación. Modelo de permisos (decidido con el usuario):
 * CUALQUIER agente puede crear una etiqueta al aplicarla desde el chat —
 * en el mostrador no se puede parar a ir a Ajustes — y ADMIN+ es quien
 * después renombra, recolorea y borra.
 *
 * De ahí que create() sea "buscar o crear" por slug en vez de fallar con
 * "ya existe": si la cajera escribe "mayorista" y ya existe "Mayorista",
 * lo que quiere es ESA etiqueta, no un error.
 */
@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Todas las del tenant + cuántas conversaciones las usan (para Ajustes). */
  async list(tenantId: string): Promise<unknown[]> {
    const db = this.prisma.db;
    const tags = (await db.tag.findMany({
      where: { tenantId },
      orderBy: [{ name: 'asc' }],
    })) as Tag[];

    const counts = await db.conversationTag.groupBy({
      by: ['tagId'],
      where: { tenantId },
      _count: { _all: true },
    });
    const countByTag = new Map(counts.map((c) => [c.tagId, c._count._all]));

    return tags.map((t) => serializeTag(t, countByTag.get(t.id) ?? 0));
  }

  /**
   * Buscar-o-crear por slug. Idempotente a propósito: dos agentes que
   * escriben la misma etiqueta al mismo tiempo terminan en la misma fila
   * (el catch del unique cubre la carrera).
   */
  async create(tenantId: string, input: { name?: unknown; color?: unknown }): Promise<unknown> {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) {
      throw new BadRequestException('El nombre de la etiqueta es obligatorio');
    }
    if (name.length > TAG_NAME_MAX) {
      throw new BadRequestException(`La etiqueta no puede pasar de ${TAG_NAME_MAX} caracteres`);
    }
    const slug = tagSlug(name);
    if (!slug) {
      throw new BadRequestException('El nombre de la etiqueta necesita al menos una letra o número');
    }
    if (input.color !== undefined && !isTagColor(input.color)) {
      throw new BadRequestException(`Color inválido — usá uno de: ${TAG_COLORS.join(', ')}`);
    }
    const color = isTagColor(input.color) ? input.color : DEFAULT_TAG_COLOR;

    const db = this.prisma.db;
    const existing = (await db.tag.findFirst({ where: { tenantId, slug } })) as Tag | null;
    if (existing) return serializeTag(existing);

    try {
      const created = (await db.tag.create({ data: { tenantId, name, slug, color } })) as Tag;
      return serializeTag(created);
    } catch (error) {
      // Carrera con otro agente creando la misma etiqueta: la de él sirve.
      if ((error as { code?: string } | null)?.code === 'P2002') {
        const winner = (await db.tag.findFirst({ where: { tenantId, slug } })) as Tag | null;
        if (winner) return serializeTag(winner);
      }
      throw error;
    }
  }

  /** Renombrar / recolorear — ADMIN+ (el guard lo aplica el controller). */
  async update(
    tenantId: string,
    id: string,
    input: { name?: unknown; color?: unknown },
  ): Promise<unknown> {
    const db = this.prisma.db;
    const tag = (await db.tag.findFirst({ where: { id, tenantId } })) as Tag | null;
    if (!tag) throw new NotFoundException(`Etiqueta ${id} no existe`);

    const data: { name?: string; slug?: string; color?: string } = {};

    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
      if (!name) throw new BadRequestException('El nombre de la etiqueta es obligatorio');
      if (name.length > TAG_NAME_MAX) {
        throw new BadRequestException(`La etiqueta no puede pasar de ${TAG_NAME_MAX} caracteres`);
      }
      const slug = tagSlug(name);
      if (!slug) {
        throw new BadRequestException('El nombre necesita al menos una letra o número');
      }
      // Renombrar a algo que ya existe sería fusionar dos etiquetas: eso es
      // otra operación (y otra decisión), no un rename silencioso.
      const clash = await db.tag.findFirst({ where: { tenantId, slug, id: { not: id } } });
      if (clash) {
        throw new BadRequestException(`Ya existe una etiqueta "${(clash as Tag).name}"`);
      }
      data.name = name;
      data.slug = slug;
    }

    if (input.color !== undefined) {
      if (!isTagColor(input.color)) {
        throw new BadRequestException(`Color inválido — usá uno de: ${TAG_COLORS.join(', ')}`);
      }
      data.color = input.color;
    }

    if (Object.keys(data).length > 0) {
      await db.tag.updateMany({ where: { id, tenantId }, data });
    }
    const fresh = (await db.tag.findFirst({ where: { id, tenantId } })) as Tag;
    return serializeTag(fresh);
  }

  /**
   * Borrado REAL (no soft): una etiqueta que ya no se usa no aporta nada al
   * historial, y el cascade del join la saca de las conversaciones. Distinto
   * de QuickReply, donde el soft-delete preserva la referencia de uso.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    const { count } = await this.prisma.db.tag.deleteMany({ where: { id, tenantId } });
    if (count === 0) throw new NotFoundException(`Etiqueta ${id} no existe`);
  }

  /**
   * Reemplaza el juego COMPLETO de etiquetas de una conversación. Idempotente
   * y sin add/remove por separado: la UI manda el estado final y no hay que
   * razonar sobre el orden de dos requests concurrentes.
   */
  async setForConversation(
    tenantId: string,
    conversationId: string,
    rawTagIds: unknown,
  ): Promise<unknown[]> {
    if (!Array.isArray(rawTagIds) || rawTagIds.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('tagIds debe ser un array de ids');
    }
    const tagIds = [...new Set(rawTagIds as string[])];
    if (tagIds.length > MAX_TAGS_PER_CONVERSATION) {
      throw new BadRequestException(
        `Máximo ${MAX_TAGS_PER_CONVERSATION} etiquetas por conversación`,
      );
    }

    const db = this.prisma.db;
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) throw new NotFoundException(`Conversación ${conversationId} no existe`);

    // Las etiquetas tienen que ser de ESTE tenant: un id ajeno es 400, no un
    // vínculo silencioso entre tenants.
    const tags = (await db.tag.findMany({ where: { tenantId, id: { in: tagIds } } })) as Tag[];
    if (tags.length !== tagIds.length) {
      throw new BadRequestException('Alguna de las etiquetas no existe en este restaurante');
    }

    await db.$transaction([
      db.conversationTag.deleteMany({
        where: { tenantId, conversationId, tagId: { notIn: tagIds.length ? tagIds : ['—'] } },
      }),
      ...tagIds.map((tagId) =>
        db.conversationTag.upsert({
          where: { conversationId_tagId: { conversationId, tagId } },
          create: { tenantId, conversationId, tagId },
          update: {},
        }),
      ),
    ]);

    return this.forConversations(tenantId, [conversationId]).then(
      (byConversation) => byConversation.get(conversationId) ?? [],
    );
  }

  /**
   * Etiquetas de varias conversaciones en UN query — lo usa el listado para
   * no caer en N+1 (el mismo criterio que los contactos embebidos).
   */
  async forConversations(
    tenantId: string,
    conversationIds: string[],
  ): Promise<Map<string, Record<string, unknown>[]>> {
    const byConversation = new Map<string, Record<string, unknown>[]>();
    if (conversationIds.length === 0) return byConversation;

    const rows = await this.prisma.db.conversationTag.findMany({
      where: { tenantId, conversationId: { in: conversationIds } },
      include: { tag: true },
      orderBy: [{ createdAt: 'asc' }],
    });

    for (const row of rows) {
      const list = byConversation.get(row.conversationId) ?? [];
      list.push(serializeTag(row.tag as Tag));
      byConversation.set(row.conversationId, list);
    }
    return byConversation;
  }

  /** Ids de etiqueta cuyo nombre matchea la búsqueda (para buscar por etiqueta). */
  async searchTagIds(tenantId: string, q: string): Promise<string[]> {
    const rows = await this.prisma.db.tag.findMany({
      where: {
        tenantId,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          // También por slug: quien escribe "sin gluten" matchea "sin-gluten".
          { slug: { contains: tagSlug(q) || ' ' } },
        ],
      },
      select: { id: true },
      take: 50,
    });
    return rows.map((r) => r.id);
  }
}
