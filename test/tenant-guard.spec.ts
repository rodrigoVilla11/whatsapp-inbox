import { describe, expect, it } from 'vitest';
import {
  MissingTenantScopeError,
  assertTenantScoped,
  hasTenantScope,
} from '../src/prisma/tenant-guard';

const T = 'tenant_abc';

describe('hasTenantScope', () => {
  it('acepta tenantId directo y como { equals }', () => {
    expect(hasTenantScope({ tenantId: T })).toBe(true);
    expect(hasTenantScope({ tenantId: { equals: T } })).toBe(true);
  });

  it('acepta uniques compuestos generados por Prisma', () => {
    expect(hasTenantScope({ tenantId_waId: { tenantId: T, waId: '549341...' } })).toBe(true);
    expect(hasTenantScope({ tenantId_wamid: { tenantId: T, wamid: 'wamid.X' } })).toBe(true);
  });

  it('acepta tenantId dentro de AND (array u objeto)', () => {
    expect(hasTenantScope({ AND: [{ tenantId: T }, { status: 'OPEN' }] })).toBe(true);
    expect(hasTenantScope({ AND: { tenantId: T } })).toBe(true);
  });

  it('rechaza where vacío, sin tenantId, o con tenantId inválido', () => {
    expect(hasTenantScope(undefined)).toBe(false);
    expect(hasTenantScope({})).toBe(false);
    expect(hasTenantScope({ status: 'OPEN' })).toBe(false);
    expect(hasTenantScope({ tenantId: '' })).toBe(false);
    expect(hasTenantScope({ tenantId: null })).toBe(false);
  });

  it('rechaza tenantId solo dentro de OR/NOT (no garantiza todas las ramas)', () => {
    expect(hasTenantScope({ OR: [{ tenantId: T }, { status: 'OPEN' }] })).toBe(false);
    expect(hasTenantScope({ NOT: { tenantId: T } })).toBe(false);
  });
});

describe('assertTenantScoped', () => {
  it('deja pasar modelos de plataforma sin scope', () => {
    for (const model of ['Tenant', 'MetaApp', 'WebhookEvent', 'WhatsappAccount', 'User']) {
      expect(() => assertTenantScoped(model, 'findMany', {})).not.toThrow();
    }
  });

  it('corta findMany/count/deleteMany del dominio sin where o sin tenantId', () => {
    expect(() => assertTenantScoped('Conversation', 'findMany', undefined)).toThrow(
      MissingTenantScopeError,
    );
    expect(() => assertTenantScoped('Message', 'count', {})).toThrow(MissingTenantScopeError);
    expect(() =>
      assertTenantScoped('Contact', 'deleteMany', { where: { isBlocked: true } }),
    ).toThrow(MissingTenantScopeError);
    expect(() =>
      assertTenantScoped('QuickReply', 'updateMany', { where: { isActive: true }, data: {} }),
    ).toThrow(MissingTenantScopeError);
  });

  it('deja pasar queries del dominio correctamente scopeadas', () => {
    expect(() =>
      assertTenantScoped('Conversation', 'findMany', { where: { tenantId: T, status: 'OPEN' } }),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped('Message', 'findUnique', {
        where: { tenantId_wamid: { tenantId: T, wamid: 'wamid.X' } },
      }),
    ).not.toThrow();
  });

  it('findUnique por id pelado NO pasa: se exige findFirst con { id, tenantId }', () => {
    expect(() => assertTenantScoped('Contact', 'findUnique', { where: { id: 'c_1' } })).toThrow(
      MissingTenantScopeError,
    );
    expect(() =>
      assertTenantScoped('Contact', 'findFirst', { where: { id: 'c_1', tenantId: T } }),
    ).not.toThrow();
  });

  it('create/createMany exigen tenantId (escalar o connect) en data', () => {
    expect(() =>
      assertTenantScoped('Message', 'create', { data: { body: 'hola' } }),
    ).toThrow(MissingTenantScopeError);
    expect(() =>
      assertTenantScoped('Message', 'create', { data: { tenantId: T, body: 'hola' } }),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped('Message', 'create', { data: { tenant: { connect: { id: T } } } }),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped('Contact', 'createMany', {
        data: [{ tenantId: T }, { waId: 'sin-tenant' }],
      }),
    ).toThrow(MissingTenantScopeError);
  });

  it('upsert exige tenant en where Y en create', () => {
    const where = { tenantId_waId: { tenantId: T, waId: 'x' } };
    expect(() =>
      assertTenantScoped('Contact', 'upsert', { where, create: { tenantId: T }, update: {} }),
    ).not.toThrow();
    expect(() =>
      assertTenantScoped('Contact', 'upsert', { where, create: { waId: 'x' }, update: {} }),
    ).toThrow(MissingTenantScopeError);
  });

  it('fail-closed: operación desconocida sobre el dominio no pasa', () => {
    expect(() => assertTenantScoped('Message', 'operacionNueva', {})).toThrow(
      MissingTenantScopeError,
    );
  });
});
