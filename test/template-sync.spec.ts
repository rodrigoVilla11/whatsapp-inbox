import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { TemplateSyncService } from '../src/messaging/template-sync.service';
import { countTemplateVariables, renderTemplateBody } from '../src/messaging/template.utils';
import type { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';

let db: FakeDb;
let graph: { listTemplates: ReturnType<typeof vi.fn> };
let service: TemplateSyncService;

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  db = createFakeDb();
  graph = { listTemplates: vi.fn() };
  service = new TemplateSyncService(
    { db } as unknown as PrismaService,
    graph as unknown as GraphApiClient,
  );
  db.whatsappAccount.seed({ id: 'acc_1', tenantId: TENANT, wabaId: 'waba_1', phoneNumberId: 'PN_1' });
});

const metaTpl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'meta_tpl_1',
  name: 'pedido_listo',
  language: 'es_AR',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Hola {{1}}! Tu pedido {{2}} está listo. {{1}}' }],
  ...over,
});

describe('template.utils', () => {
  it('variableCount = mayor índice, no cantidad de apariciones', () => {
    expect(countTemplateVariables('Hola {{1}}! Pedido {{2}} listo. {{1}}')).toBe(2);
    expect(countTemplateVariables('sin variables')).toBe(0);
  });

  it('renderTemplateBody sustituye por posición', () => {
    expect(renderTemplateBody('Hola {{1}}, pedido {{2}}', ['Ana', '#9'])).toBe('Hola Ana, pedido #9');
  });
});

describe('TemplateSyncService', () => {
  it('alta nueva: crea con status, bodyText, variableCount y syncedAt', async () => {
    graph.listTemplates.mockResolvedValueOnce([metaTpl()]);
    const result = await service.syncAccount(TENANT, 'acc_1');

    expect(result).toMatchObject({ created: 1, updated: 0, disabled: 0 });
    const row = db.messageTemplate.rows[0];
    expect(row).toMatchObject({
      tenantId: TENANT,
      name: 'pedido_listo',
      language: 'es_AR',
      status: 'APPROVED',
      variableCount: 2, // {{1}} repetido sigue siendo 2 variables ({{1}},{{2}})
      metaTemplateId: 'meta_tpl_1',
    });
    expect(row.syncedAt).toBeInstanceOf(Date);
  });

  it('cambio de status en Meta → actualiza la existente (upsert por unique cuádruple)', async () => {
    graph.listTemplates.mockResolvedValueOnce([metaTpl()]);
    await service.syncAccount(TENANT, 'acc_1');

    graph.listTemplates.mockResolvedValueOnce([metaTpl({ status: 'PAUSED' })]);
    const second = await service.syncAccount(TENANT, 'acc_1');

    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect(db.messageTemplate.rows).toHaveLength(1); // sin duplicar
    expect(db.messageTemplate.rows[0].status).toBe('PAUSED');
  });

  it('la que Meta ya no lista → se MARCA DISABLED, no se borra (y revive si reaparece)', async () => {
    graph.listTemplates.mockResolvedValueOnce([metaTpl(), metaTpl({ id: 'meta_tpl_2', name: 'promo_vieja' })]);
    await service.syncAccount(TENANT, 'acc_1');

    graph.listTemplates.mockResolvedValueOnce([metaTpl()]); // promo_vieja desapareció
    const result = await service.syncAccount(TENANT, 'acc_1');

    expect(result.disabled).toBe(1);
    const gone = db.messageTemplate.rows.find((t) => t.name === 'promo_vieja')!;
    expect(gone.status).toBe('DISABLED'); // marcada, NO borrada
    expect(db.messageTemplate.rows).toHaveLength(2);

    // reaparece en Meta → el upsert la reactiva
    graph.listTemplates.mockResolvedValueOnce([metaTpl(), metaTpl({ id: 'meta_tpl_2', name: 'promo_vieja' })]);
    await service.syncAccount(TENANT, 'acc_1');
    expect(db.messageTemplate.rows.find((t) => t.name === 'promo_vieja')!.status).toBe('APPROVED');
  });

  it('status desconocido de Meta → PENDING (no se inventan valores de enum)', async () => {
    graph.listTemplates.mockResolvedValueOnce([metaTpl({ status: 'IN_APPEAL' })]);
    await service.syncAccount(TENANT, 'acc_1');
    expect(db.messageTemplate.rows[0].status).toBe('PENDING');
  });
});
