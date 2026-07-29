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
import { TagsService } from './tags.service';

const CONVERSATIONS_PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;

/**
 * Tope de anclados que se prependen. No es una regla de producto sino una
 * defensa: los anclados NO paginan (van todos arriba de la primera página),
 * así que si alguien ancla 200 conversaciones la primera página no puede
 * volverse ilimitada. En la práctica se anclan 2 o 3.
 */
const MAX_PINNED = 20;

// Vista "Por vencer": mismo umbral que el chip gari de la UI (< 2h de las
// 24h de ventana — ver messaging/window.ts y web window-ui.ts).
const WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPIRING_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type ConversationListFilter = 'open' | 'closed' | 'all' | 'expiring' | 'unread';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphApiClient,
    private readonly tags: TagsService,
    @Inject(DOMAIN_EVENT_PUBLISHER)
    private readonly events: DomainEventPublisher,
  ) {}

  /**
   * Lista con cursor por lastMessageAt desc; contacto y etiquetas embebidos;
   * timezone una vez.
   *
   * Los ANCLADOS van arriba de todo y no paginan: se piden en un query
   * aparte que aplica el MISMO where (filtro/búsqueda/etiquetas) más
   * `pinnedAt != null`, y el query paginado agrega `pinnedAt: null`. Así el
   * cursor keyset sigue siendo válido sobre el conjunto no-anclado, y un
   * anclado que no matchea la búsqueda no se cuela en los resultados.
   */
  async list(
    tenantId: string,
    userId: string | null,
    options: {
      filter?: ConversationListFilter;
      assignedToMe?: boolean;
      cursor?: string;
      q?: string;
      tagIds?: string[];
    },
  ): Promise<{ conversations: unknown[]; nextCursor: string | null; timezone: string }> {
    const db = this.prisma.db;
    const cursor = decodeCursor(options.cursor);
    const q = options.q?.trim() || null;

    // Búsqueda: cruza TODOS los estados (quien busca "María" quiere
    // encontrarla aunque la conversación esté cerrada); sin q, rige el filtro.
    const now = Date.now();
    const statusWhere: Prisma.ConversationWhereInput = q
      ? {}
      : options.filter === 'all'
        ? {}
        : options.filter === 'closed'
          ? { status: 'CLOSED' }
          : options.filter === 'unread'
            ? { status: { in: ['OPEN', 'PENDING'] }, unreadCount: { gt: 0 } }
            : options.filter === 'expiring'
              ? {
                  // ventana abierta con < 2h restantes: lastInboundAt entre
                  // 22 y 24 horas atrás
                  status: { in: ['OPEN', 'PENDING'] },
                  lastInboundAt: {
                    gt: new Date(now - WINDOW_MS),
                    lte: new Date(now - (WINDOW_MS - EXPIRING_THRESHOLD_MS)),
                  },
                }
              : { status: { in: ['OPEN', 'PENDING'] } }; // default

    // "Por vencer" ordena por URGENCIA (la más cerca de vencer primero) y
    // no pagina: es una lista de incendios, no un archivo.
    const expiring = !q && options.filter === 'expiring';

    // Búsqueda: matchea por CONTACTO (nombre/teléfono) o por ETIQUETA —
    // "mayorista" tiene que encontrar las conversaciones etiquetadas así
    // aunque ningún contacto se llame Mayorista.
    let searchWhere: Prisma.ConversationWhereInput | null = null;
    if (q) {
      const [contacts, tagIds] = await Promise.all([
        this.searchContacts(tenantId, q),
        this.tags.searchTagIds(tenantId, q),
      ]);
      const contactIds = contacts.map((c) => c.id);
      if (contactIds.length === 0 && tagIds.length === 0) {
        const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
        return { conversations: [], nextCursor: null, timezone: tenant?.timezone ?? 'UTC' };
      }
      searchWhere = {
        OR: [
          ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
          ...(tagIds.length ? [{ tags: { some: { tagId: { in: tagIds } } } }] : []),
        ],
      };
    }

    // Filtro por etiqueta: OR entre las elegidas (es lo que espera quien
    // toca dos chips — "mostrame reclamos o mayoristas").
    const tagFilterIds = (options.tagIds ?? []).filter((id) => typeof id === 'string' && id);
    const tagWhere: Prisma.ConversationWhereInput = tagFilterIds.length
      ? { tags: { some: { tagId: { in: tagFilterIds } } } }
      : {};

    const baseWhere: Prisma.ConversationWhereInput = {
      tenantId,
      ...statusWhere,
      ...(searchWhere ?? {}),
      ...tagWhere,
      ...(options.assignedToMe && userId ? { assignedUserId: userId } : {}),
    };

    // "Por vencer" NO separa anclados: ordena por urgencia y un anclado que
    // está por vencer tiene que salir en su lugar de la fila de incendios
    // (si se excluyera con pinnedAt: null, desaparecería de la vista).
    const withPins = !expiring;

    // Los anclados solo en la PRIMERA página (sin cursor).
    const pinnedRows: Conversation[] =
      withPins && !cursor
        ? ((await db.conversation.findMany({
            where: { ...baseWhere, pinnedAt: { not: null } },
            orderBy: [{ pinnedAt: 'desc' }, { id: 'desc' }],
            take: MAX_PINNED,
          })) as Conversation[])
        : [];

    const rows = (await db.conversation.findMany({
      where: {
        ...baseWhere,
        ...(withPins ? { pinnedAt: null } : {}),
        ...(cursor && !expiring ? { AND: [this.cursorWhere(cursor, 'lastMessageAt')] } : {}),
      },
      orderBy: expiring
        ? [{ lastInboundAt: 'asc' }, { id: 'desc' }]
        : [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: CONVERSATIONS_PAGE_SIZE + 1,
    })) as Conversation[];

    const unpinnedPage = rows.slice(0, CONVERSATIONS_PAGE_SIZE);
    // El cursor se calcula SOBRE LOS NO-ANCLADOS: es el conjunto que pagina.
    const nextCursor =
      !expiring && rows.length > CONVERSATIONS_PAGE_SIZE
        ? encodeCursor({
            t: unpinnedPage[unpinnedPage.length - 1].lastMessageAt?.toISOString() ?? null,
            id: unpinnedPage[unpinnedPage.length - 1].id,
          })
        : null;
    const page = [...pinnedRows, ...unpinnedPage];

    // Contactos embebidos en un solo query.
    const contactIds = [...new Set(page.map((c) => c.contactId))];
    const contacts = (await db.contact.findMany({
      where: { tenantId, id: { in: contactIds } },
    })) as Contact[];
    const contactById = new Map(contacts.map((c) => [c.id, c]));

    // Pedido activo de Gourmetify → la fila se resalta y muestra el número
    // (del activo MÁS RECIENTE del contacto).
    const activeOrders = await db.gourmetifyOrder.findMany({
      where: {
        tenantId,
        contactId: { in: contactIds },
        statusKind: { in: ['pending', 'in_progress', 'ready'] },
      },
      orderBy: [{ orderCreatedAt: 'desc' }],
    });
    const activeByContact = new Map<string, string | null>();
    for (const order of activeOrders) {
      const contactId = order.contactId as string;
      if (!activeByContact.has(contactId)) {
        activeByContact.set(contactId, (order.number as string | null) ?? null);
      }
    }

    // Etiquetas de toda la página en UN query (mismo criterio anti-N+1 que
    // los contactos).
    const tagsByConversation = await this.tags.forConversations(
      tenantId,
      page.map((c) => c.id),
    );

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });

    return {
      conversations: page.map((c) => ({
        ...(serializeConversation(c, contactById.get(c.contactId) ?? null) as Record<
          string,
          unknown
        >),
        hasActiveOrder: activeByContact.has(c.contactId),
        activeOrderNumber: activeByContact.get(c.contactId) ?? null,
        tags: tagsByConversation.get(c.id) ?? [],
      })),
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

  /**
   * "Marcar como no leído": el gesto de "vuelvo a esto después". Pone el
   * contador en MÍNIMO 1 (si ya hay no-leídos reales, no los pisa) y emite
   * conversation.updated — badge de fila y de pestaña lo toman solos.
   */
  async markUnread(tenantId: string, conversationId: string): Promise<unknown> {
    await this.mustGet(tenantId, conversationId);
    await this.prisma.db.conversation.updateMany({
      where: { id: conversationId, tenantId, unreadCount: 0 },
      data: { unreadCount: 1 },
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

  /**
   * Anclar / desanclar — COMPARTIDO por todo el equipo (decisión de producto:
   * si la cajera ancla, el dueño también lo ve arriba). Guarda la fecha y no
   * un boolean, así el último anclado queda primero entre los anclados.
   */
  async setPinned(tenantId: string, conversationId: string, pinned: boolean): Promise<unknown> {
    await this.mustGet(tenantId, conversationId);
    await this.prisma.db.conversation.updateMany({
      where: { id: conversationId, tenantId },
      data: { pinnedAt: pinned ? new Date() : null },
    });
    return this.emitAndReturn(tenantId, conversationId);
  }

  /** PUT /conversations/:id/tags — reemplaza el juego completo y emite. */
  async setTags(
    tenantId: string,
    conversationId: string,
    tagIds: unknown,
  ): Promise<unknown> {
    const tags = await this.tags.setForConversation(tenantId, conversationId, tagIds);
    // El evento lleva las etiquetas para que la fila de la lista se actualice
    // en las otras pantallas sin refetch.
    const fresh = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (fresh) {
      await this.events.publish({
        tenantId,
        type: 'conversation.updated',
        payload: {
          conversation: { ...serializeConversation(fresh as Conversation), tags },
        },
      });
    }
    return { tags };
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
