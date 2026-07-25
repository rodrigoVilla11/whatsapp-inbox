import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Contact, Conversation, Prisma } from '@prisma/client';
import { serializeConversation, serializeMessage } from '../common/serializers';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { GraphApiClient } from '../whatsapp/graph-api.client';
import { Cursor, decodeCursor, encodeCursor } from './cursor';

const CONVERSATIONS_PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;

export type ConversationListFilter = 'open' | 'closed' | 'all';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphApiClient,
    @Inject(DOMAIN_EVENT_PUBLISHER)
    private readonly events: DomainEventPublisher,
  ) {}

  /** Lista con cursor por lastMessageAt desc; contacto embebido; timezone una vez. */
  async list(
    tenantId: string,
    userId: string | null,
    options: { filter?: ConversationListFilter; assignedToMe?: boolean; cursor?: string },
  ): Promise<{ conversations: unknown[]; nextCursor: string | null; timezone: string }> {
    const db = this.prisma.db;
    const cursor = decodeCursor(options.cursor);

    const statusWhere: Prisma.ConversationWhereInput =
      options.filter === 'all'
        ? {}
        : options.filter === 'closed'
          ? { status: 'CLOSED' }
          : { status: { in: ['OPEN', 'PENDING'] } }; // default

    const rows = (await db.conversation.findMany({
      where: {
        tenantId,
        ...statusWhere,
        ...(options.assignedToMe && userId ? { assignedUserId: userId } : {}),
        ...(cursor ? { AND: [this.cursorWhere(cursor, 'lastMessageAt')] } : {}),
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: CONVERSATIONS_PAGE_SIZE + 1,
    })) as Conversation[];

    const page = rows.slice(0, CONVERSATIONS_PAGE_SIZE);
    const nextCursor =
      rows.length > CONVERSATIONS_PAGE_SIZE
        ? encodeCursor({
            t: page[page.length - 1].lastMessageAt?.toISOString() ?? null,
            id: page[page.length - 1].id,
          })
        : null;

    // Contactos embebidos en un solo query.
    const contactIds = [...new Set(page.map((c) => c.contactId))];
    const contacts = (await db.contact.findMany({
      where: { tenantId, id: { in: contactIds } },
    })) as Contact[];
    const contactById = new Map(contacts.map((c) => [c.id, c]));

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });

    return {
      conversations: page.map((c) =>
        serializeConversation(c, contactById.get(c.contactId) ?? null),
      ),
      nextCursor,
      timezone: tenant?.timezone ?? 'UTC',
    };
  }

  /** Hilo con cursor por timestamp desc (la UI pagina hacia arriba). */
  async listMessages(
    tenantId: string,
    conversationId: string,
    rawCursor?: string,
  ): Promise<{ messages: unknown[]; nextCursor: string | null }> {
    const db = this.prisma.db;
    await this.mustGet(tenantId, conversationId);
    const cursor = decodeCursor(rawCursor);

    const rows = await db.message.findMany({
      where: {
        tenantId,
        conversationId,
        ...(cursor ? { AND: [this.cursorWhere(cursor, 'timestamp')] } : {}),
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: MESSAGES_PAGE_SIZE + 1,
    });

    const page = rows.slice(0, MESSAGES_PAGE_SIZE);
    const nextCursor =
      rows.length > MESSAGES_PAGE_SIZE
        ? encodeCursor({
            t: (page[page.length - 1].timestamp as Date).toISOString(),
            id: page[page.length - 1].id,
          })
        : null;

    return { messages: page.map(serializeMessage), nextCursor };
  }

  /**
   * unreadCount → 0 + conversation.updated. Además, tildes azules para el
   * cliente del restaurante: mark-read en Meta del último entrante —
   * best-effort, un fallo se loguea y no rompe nada.
   */
  async markRead(tenantId: string, conversationId: string): Promise<unknown> {
    const db = this.prisma.db;
    const conversation = await this.mustGet(tenantId, conversationId);

    await db.conversation.updateMany({
      where: { id: conversationId, tenantId },
      data: { unreadCount: 0 },
    });

    void this.markReadOnMeta(tenantId, conversation).catch((error) => {
      this.logger.warn(`mark-read en Meta falló (cortesía, se sigue): ${String(error)}`);
    });

    return this.emitAndReturn(tenantId, conversationId);
  }

  async assign(tenantId: string, conversationId: string, userId: string | null): Promise<unknown> {
    const db = this.prisma.db;
    await this.mustGet(tenantId, conversationId);

    if (userId !== null) {
      const user = await db.user.findFirst({
        where: { id: userId, tenantId, isActive: true },
      });
      if (!user) {
        throw new BadRequestException(`Usuario ${userId} no existe en este tenant`);
      }
    }
    await db.conversation.updateMany({
      where: { id: conversationId, tenantId },
      data: { assignedUserId: userId },
    });
    return this.emitAndReturn(tenantId, conversationId);
  }

  async setStatus(
    tenantId: string,
    conversationId: string,
    status: 'OPEN' | 'CLOSED',
  ): Promise<unknown> {
    await this.mustGet(tenantId, conversationId);
    await this.prisma.db.conversation.updateMany({
      where: { id: conversationId, tenantId },
      data: { status },
    });
    return this.emitAndReturn(tenantId, conversationId);
  }

  // ────────────────────────────────────────────────────────────────────

  private cursorWhere(cursor: Cursor, field: 'lastMessageAt' | 'timestamp'): object {
    const t = cursor.t ? new Date(cursor.t) : null;
    if (!t) {
      // Página anclada en filas sin timestamp (solo posible en conversaciones
      // vacías): sigue por id entre las que también son null.
      return { OR: [{ AND: [{ [field]: null }, { id: { lt: cursor.id } }] }] };
    }
    return {
      OR: [
        { [field]: { lt: t } },
        { AND: [{ [field]: t }, { id: { lt: cursor.id } }] },
        ...(field === 'lastMessageAt' ? [{ [field]: null }] : []), // las vacías van al final
      ],
    };
  }

  private async mustGet(tenantId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversación ${conversationId} no existe`);
    }
    return conversation as Conversation;
  }

  private async emitAndReturn(tenantId: string, conversationId: string): Promise<unknown> {
    const fresh = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (fresh) {
      await this.events.publish({
        tenantId,
        type: 'conversation.updated',
        payload: { conversation: serializeConversation(fresh as Conversation) },
      });
    }
    return fresh ? serializeConversation(fresh as Conversation) : null;
  }

  private async markReadOnMeta(tenantId: string, conversation: Conversation): Promise<void> {
    const db = this.prisma.db;
    const lastInbound = await db.message.findFirst({
      where: {
        tenantId,
        conversationId: conversation.id,
        direction: 'INBOUND',
        wamid: { not: null },
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    if (!lastInbound?.wamid) return;
    const account = await db.whatsappAccount.findUnique({
      where: { id: conversation.whatsappAccountId },
    });
    if (!account) return;
    await this.graph.markMessageRead(account, lastInbound.wamid as string);
  }
}
