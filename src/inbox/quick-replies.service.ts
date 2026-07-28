import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface QuickReplyInput {
  shortcut?: string;
  title?: string;
  body?: string;
  isActive?: boolean;
  isFavorite?: boolean;
}

/** Tope de chips arriba del composer: más que esto deja de ser "rápido". */
export const MAX_FAVORITES = 4;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/** El link de la carta y las respuestas de cada restaurante son DATOS por tenant. */
@Injectable()
export class QuickRepliesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, includeInactive = false): Promise<unknown[]> {
    return this.prisma.db.quickReply.findMany({
      where: { tenantId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ shortcut: 'asc' }],
    });
  }

  async create(
    tenantId: string,
    input: { shortcut: string; title: string; body: string },
  ): Promise<unknown> {
    this.validate(input);
    try {
      return await this.prisma.db.quickReply.create({
        data: { tenantId, shortcut: input.shortcut, title: input.title, body: input.body },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BadRequestException(`El atajo ${input.shortcut} ya existe`);
      }
      throw error;
    }
  }

  async update(tenantId: string, id: string, input: QuickReplyInput): Promise<unknown> {
    if (input.shortcut !== undefined || input.title !== undefined || input.body !== undefined) {
      this.validate(input, { partial: true });
    }
    // Tope de favoritas: la 5ª estrella rebota con mensaje claro.
    if (input.isFavorite === true) {
      const favorites = await this.prisma.db.quickReply.findMany({
        where: { tenantId, isFavorite: true, isActive: true, id: { not: id } },
      });
      if (favorites.length >= MAX_FAVORITES) {
        throw new BadRequestException(
          `Ya hay ${MAX_FAVORITES} respuestas como chip — sacale la estrella a otra primero`,
        );
      }
    }
    try {
      const { count } = await this.prisma.db.quickReply.updateMany({
        where: { id, tenantId },
        data: {
          ...(input.shortcut !== undefined ? { shortcut: input.shortcut } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.isFavorite !== undefined ? { isFavorite: input.isFavorite } : {}),
        },
      });
      if (count === 0) throw new NotFoundException(`QuickReply ${id} no existe`);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BadRequestException(`El atajo ${input.shortcut} ya existe`);
      }
      throw error;
    }
    return this.prisma.db.quickReply.findFirst({ where: { id, tenantId } });
  }

  /** Borrado SOFT: isActive false — el historial de uso no pierde referencia. */
  async deactivate(tenantId: string, id: string): Promise<void> {
    const { count } = await this.prisma.db.quickReply.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    });
    if (count === 0) throw new NotFoundException(`QuickReply ${id} no existe`);
  }

  private validate(input: QuickReplyInput, opts: { partial?: boolean } = {}): void {
    if (input.shortcut !== undefined || !opts.partial) {
      const shortcut = input.shortcut ?? '';
      if (!shortcut.startsWith('/') || shortcut.length < 2 || shortcut.length > 32 || /\s/.test(shortcut)) {
        throw new BadRequestException(
          "El atajo debe empezar con '/', sin espacios (ej: /carta), de 2 a 32 caracteres",
        );
      }
    }
    if ((input.title !== undefined || !opts.partial) && !(input.title ?? '').trim()) {
      throw new BadRequestException('title requerido');
    }
    if ((input.body !== undefined || !opts.partial) && !(input.body ?? '').trim()) {
      throw new BadRequestException('body requerido');
    }
  }
}
