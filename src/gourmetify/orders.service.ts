import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Contact, GourmetifyOrder, Tenant } from '@prisma/client';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Pedidos de Gourmetify en el chat. Ingesta por webhook (push): Gourmetify
 * avisa al crear el pedido y en cada cambio de estado; acá se upsertea el
 * espejo y se emite `order.updated` al room del tenant — el chip del hilo
 * y el panel se actualizan en vivo sin polling.
 *
 * Contrato display-ready: los *Label se muestran tal cual; statusKind es
 * lo ÚNICO que el inbox interpreta (colores/partición activo-cerrado).
 */

export const ORDER_STATUS_KINDS = ['pending', 'in_progress', 'ready', 'done', 'cancelled'] as const;
export type OrderStatusKind = (typeof ORDER_STATUS_KINDS)[number];

const ACTIVE_KINDS: ReadonlySet<string> = new Set(['pending', 'in_progress', 'ready']);
const RECENT_LIMIT = 3;

export interface OrderIngestInput {
  gourmetifyTenantId?: unknown;
  order?: {
    id?: unknown;
    number?: unknown;
    customerPhone?: unknown;
    statusLabel?: unknown;
    statusKind?: unknown;
    summary?: unknown;
    totalLabel?: unknown;
    deliveryLabel?: unknown;
    scheduledLabel?: unknown;
    createdAt?: unknown;
  };
}

export function serializeOrder(order: GourmetifyOrder): Record<string, unknown> {
  return {
    id: order.id,
    gourmetifyOrderId: order.gourmetifyOrderId,
    contactId: order.contactId,
    number: order.number,
    statusLabel: order.statusLabel,
    statusKind: order.statusKind,
    summary: order.summary,
    totalLabel: order.totalLabel,
    deliveryLabel: order.deliveryLabel,
    scheduledLabel: order.scheduledLabel,
    orderCreatedAt: order.orderCreatedAt,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`Falta ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

@Injectable()
export class GourmetifyOrdersService {
  private readonly logger = new Logger(GourmetifyOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  /** Webhook de Gourmetify: upsert idempotente por [tenant, gourmetifyOrderId]. */
  async ingestOrder(input: OrderIngestInput): Promise<unknown> {
    const gourmetifyTenantId = requireString(input.gourmetifyTenantId, 'gourmetifyTenantId');
    const db = this.prisma.db;
    const tenant = (await db.tenant.findUnique({
      where: { gourmetifyTenantId },
    })) as Tenant | null;
    if (!tenant) {
      throw new NotFoundException(`No hay tenant para gourmetifyTenantId=${gourmetifyTenantId}`);
    }

    const gourmetifyOrderId = requireString(input.order?.id, 'order.id');
    const statusLabel = requireString(input.order?.statusLabel, 'order.statusLabel');
    const statusKind = requireString(input.order?.statusKind, 'order.statusKind');
    if (!ORDER_STATUS_KINDS.includes(statusKind as OrderStatusKind)) {
      throw new BadRequestException(
        `order.statusKind inválido ("${statusKind}") — esperado: ${ORDER_STATUS_KINDS.join(' | ')}`,
      );
    }
    const customerPhone = requireString(input.order?.customerPhone, 'order.customerPhone').replace(
      /\D/g,
      '',
    );
    if (customerPhone.length < 8) {
      throw new BadRequestException('order.customerPhone inválido');
    }
    const createdAtRaw = requireString(input.order?.createdAt, 'order.createdAt');
    const orderCreatedAt = new Date(createdAtRaw);
    if (Number.isNaN(orderCreatedAt.getTime())) {
      throw new BadRequestException('order.createdAt inválido (se espera ISO 8601)');
    }

    // Link al contacto si ya existe (si no, queda por teléfono y la lectura
    // lo backfillea cuando el cliente escriba).
    const contact = (await db.contact.findFirst({
      where: { tenantId: tenant.id, waId: customerPhone },
    })) as Contact | null;

    const data = {
      contactId: contact?.id ?? null,
      customerPhone,
      number: optionalString(input.order?.number),
      statusLabel,
      statusKind,
      summary: optionalString(input.order?.summary),
      totalLabel: optionalString(input.order?.totalLabel),
      deliveryLabel: optionalString(input.order?.deliveryLabel),
      scheduledLabel: optionalString(input.order?.scheduledLabel),
      orderCreatedAt,
    };

    const order = (await db.gourmetifyOrder.upsert({
      where: {
        tenantId_gourmetifyOrderId: { tenantId: tenant.id, gourmetifyOrderId },
      },
      create: { tenantId: tenant.id, gourmetifyOrderId, ...data },
      update: data,
    })) as GourmetifyOrder;

    await this.events.publish({
      tenantId: tenant.id,
      type: 'order.updated',
      payload: { order: serializeOrder(order), contactId: order.contactId },
    });

    return { ok: true, order: serializeOrder(order) };
  }

  /** Pedidos del contacto de una conversación: activos + últimos 3 cerrados. */
  async listForConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<{ active: unknown[]; recent: unknown[] }> {
    const db = this.prisma.db;
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversación ${conversationId} no existe`);
    }
    const contact = (await db.contact.findFirst({
      where: { id: conversation.contactId as string, tenantId },
    })) as Contact | null;
    if (!contact) return { active: [], recent: [] };

    const rows = (await db.gourmetifyOrder.findMany({
      where: {
        tenantId,
        OR: [{ contactId: contact.id }, { customerPhone: contact.waId }],
      },
      orderBy: [{ orderCreatedAt: 'desc' }],
      take: 50, // techo defensivo; la partición de abajo recorta
    })) as GourmetifyOrder[];

    // Backfill del link contactId para pedidos que llegaron antes del contacto.
    const unlinked = rows.filter((o) => !o.contactId);
    if (unlinked.length > 0) {
      await db.gourmetifyOrder.updateMany({
        where: { tenantId, customerPhone: contact.waId, contactId: null },
        data: { contactId: contact.id },
      });
    }

    const active = rows.filter((o) => ACTIVE_KINDS.has(o.statusKind));
    const recent = rows.filter((o) => !ACTIVE_KINDS.has(o.statusKind)).slice(0, RECENT_LIMIT);
    return { active: active.map(serializeOrder), recent: recent.map(serializeOrder) };
  }
}
