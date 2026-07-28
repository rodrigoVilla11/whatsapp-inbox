import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Contact, Conversation, Prisma } from '@prisma/client';
import { serializeContact, serializeConversation, serializeMessage } from '../common/serializers';
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
    options: {
      filter?: ConversationListFilter;
      assignedToMe?: boolean;
      cursor?: string;
      q?: string;
    },
  ): Promise<{ conversations: unknown[]; nextCursor: string | null; timezone: string }> {
    const db = this.prisma.db;
    const cursor = decodeCursor(options.cursor);
    const q = options.q?.trim() || null;

    // Búsqueda: cruza TODOS los estados (quien busca "María" quiere
    // encontrarla aunque la conversación esté cerrada); sin q, rige el filtro.
    const statusWhere: Prisma.ConversationWhereInput = q
      ? {}
      : options.filter === 'all'
        ? {}
        : options.filter === 'closed'
          ? { status: 'CLOSED' }
          : { status: { in: ['OPEN', 'PENDING'] } }; // default

    let searchContactIds: string[] | null = null;
    if (q) {
      searchContactIds = (await this.searchContacts(tenantId, q)).map((c) => c.id);
      if (searchContactIds.length === 0) {
        const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
        return { conversations: [], nextCursor: null, timezone: tenant?.timezone ?? 'UTC' };
      }
    }

    const rows = (await db.conversation.findMany({
      where: {
        tenantId,
        ...statusWhere,
        ...(searchContactIds ? { contactId: { in: searchContactIds } } : {}),
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

  /**
   * Deep-link desde Gourmetify (reemplazo de wa.me): abre o crea la
   * conversación del teléfono. Idempotente: mismo teléfono → misma
   * conversación (upsert por el unique [tenant, cuenta, contacto]).
   */
  async openByPhone(tenantId: string, rawPhone: string): Promise<unknown> {
    const digits = String(rawPhone ?? '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      throw new BadRequestException(
        'Teléfono inválido — se espera el número internacional (como en wa.me)',
      );
    }
    const db = this.prisma.db;

    let contact = (await db.contact.findFirst({
      where: { tenantId, waId: digits },
    })) as Contact | null;

    // La cuenta define a qué conversación pertenece. Se prefiere ACTIVE,
    // pero una PENDING también sirve: el resto del sistema (webhook,
    // envíos) no filtra por status y acá no vamos a ser más estrictos.
    const account =
      (await db.whatsappAccount.findFirst({ where: { tenantId, status: 'ACTIVE' } })) ??
      (await db.whatsappAccount.findFirst({ where: { tenantId } }));
    if (!account) {
      throw new BadRequestException(
        'Este restaurante no tiene una cuenta de WhatsApp configurada',
      );
    }

    if (!contact) {
      contact = (await db.contact.create({
        data: { tenantId, waId: digits, phoneE164: `+${digits}` },
      })) as Contact;
    }

    const conversation = (await db.conversation.upsert({
      where: {
        tenantId_whatsappAccountId_contactId: {
          tenantId,
          whatsappAccountId: account.id as string,
          contactId: contact.id,
        },
      },
      create: {
        tenantId,
        whatsappAccountId: account.id as string,
        contactId: contact.id,
        status: 'OPEN',
      },
      update: {},
    })) as Conversation;

    await this.events.publish({
      tenantId,
      type: 'conversation.updated',
      payload: { conversation: serializeConversation(conversation) },
    });
    return serializeConversation(conversation, contact);
  }

  /** PATCH /contacts/:id — SOLO notes. '' se guarda como null. */
  async updateContactNotes(
    tenantId: string,
    contactId: string,
    notes: string | null,
  ): Promise<unknown> {
    const db = this.prisma.db;
    const existing = await db.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!existing) {
      throw new NotFoundException(`Contacto ${contactId} no existe`);
    }
    await db.contact.updateMany({
      where: { id: contactId, tenantId },
      data: { notes: notes?.trim() ? notes : null },
    });
    const fresh = await db.contact.findFirst({ where: { id: contactId, tenantId } });
    return serializeContact(fresh as Contact);
  }

  // ────────────────────────────────────────────────────────────────────

  /**
   * ILIKE %q% sobre profileName; si q trae dígitos, también sobre
   * phoneE164/waId (normalizado: "+54 9 341" matchea el waId "549341…").
   * Índices trigram de la migración contact_search_trgm.
   */
  private async searchContacts(tenantId: string, q: string): Promise<Contact[]> {
    const digits = q.replace(/\D/g, '');
    const or: Prisma.ContactWhereInput[] = [
      { profileName: { contains: q, mode: 'insensitive' } },
    ];
    if (digits.length > 0) {
      or.push({ phoneE164: { contains: digits } }, { waId: { contains: digits } });
    }
    return (await this.prisma.db.contact.findMany({
      where: { tenantId, OR: or },
      take: 200, // techo defensivo: la búsqueda alimenta una lista, no un export
    })) as Contact[];
  }

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
