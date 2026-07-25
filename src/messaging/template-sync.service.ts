import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TemplateStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GraphApiClient, MetaTemplateDefinition } from '../whatsapp/graph-api.client';
import { countTemplateVariables } from './template.utils';

export interface TemplateSyncResult {
  whatsappAccountId: string;
  created: number;
  updated: number;
  disabled: number;
  total: number;
}

/**
 * Estados de Meta → nuestro enum. Desconocidos (IN_APPEAL, etc.) caen a
 * PENDING: cualquier cosa no-APPROVED bloquea el envío igual, y no
 * inventamos valores de enum por cada estado nuevo de Meta.
 */
const META_TEMPLATE_STATUS: Record<string, TemplateStatus> = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
};

@Injectable()
export class TemplateSyncService {
  private readonly logger = new Logger(TemplateSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphApiClient,
  ) {}

  /** Sincroniza todas las cuentas del tenant (hoy: una). */
  async syncTenant(tenantId: string): Promise<TemplateSyncResult[]> {
    const accounts = await this.prisma.db.whatsappAccount.findMany({ where: { tenantId } });
    const results: TemplateSyncResult[] = [];
    for (const account of accounts) {
      results.push(await this.syncAccount(tenantId, account.id));
    }
    return results;
  }

  async syncAccount(tenantId: string, whatsappAccountId: string): Promise<TemplateSyncResult> {
    const db = this.prisma.db;
    const account = await db.whatsappAccount.findFirst({
      where: { id: whatsappAccountId, tenantId },
    });
    if (!account) {
      throw new NotFoundException(`WhatsappAccount ${whatsappAccountId} no existe`);
    }

    const metaTemplates = await this.graph.listTemplates(account);
    const now = new Date();
    let created = 0;
    let updated = 0;

    const seen = new Set<string>();
    for (const meta of metaTemplates) {
      if (!meta.name || !meta.language) continue;
      seen.add(`${meta.name}::${meta.language}`);

      const bodyText =
        meta.components?.find((c) => c.type?.toUpperCase() === 'BODY')?.text ?? '';
      const data = {
        category: meta.category ?? 'UNKNOWN',
        status: META_TEMPLATE_STATUS[meta.status ?? ''] ?? 'PENDING',
        bodyText,
        components: (meta.components ?? []) as object[],
        variableCount: countTemplateVariables(bodyText),
        metaTemplateId: meta.id ?? null,
        syncedAt: now,
      };

      const existing = await db.messageTemplate.findUnique({
        where: {
          tenantId_whatsappAccountId_name_language: {
            tenantId,
            whatsappAccountId,
            name: meta.name,
            language: meta.language,
          },
        },
      });
      if (existing) {
        await db.messageTemplate.updateMany({
          where: { id: existing.id, tenantId },
          data,
        });
        updated += 1;
      } else {
        await db.messageTemplate.create({
          data: { tenantId, whatsappAccountId, name: meta.name, language: meta.language, ...data },
        });
        created += 1;
      }
    }

    // Plantillas que Meta ya no lista: se MARCAN DISABLED, no se borran.
    // Motivo: el histórico de Message.templateName sigue explicable, y si
    // Meta la vuelve a listar el próximo sync la reactiva solo.
    const local = await db.messageTemplate.findMany({
      where: { tenantId, whatsappAccountId, status: { not: 'DISABLED' } },
    });
    let disabled = 0;
    for (const row of local) {
      if (!seen.has(`${row.name}::${row.language}`)) {
        await db.messageTemplate.updateMany({
          where: { id: row.id, tenantId },
          data: { status: 'DISABLED', syncedAt: now },
        });
        disabled += 1;
      }
    }

    this.logger.log(
      `syncAccount ${whatsappAccountId}: ${created} nuevas, ${updated} actualizadas, ${disabled} deshabilitadas`,
    );
    return { whatsappAccountId, created, updated, disabled, total: metaTemplates.length };
  }
}
