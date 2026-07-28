import { Prisma } from '@prisma/client';

/**
 * Guardia de aislamiento multi-tenant, en runtime.
 *
 * Los tipos de Prisma ya obligan tenantId en los findUnique (uniques
 * compuestos) y en los create (campo requerido). Este guardia cubre lo que
 * los tipos NO cubren: findMany / updateMany / deleteMany / count / etc.
 * sin scope — las queries que filtran datos entre tenants.
 *
 * Tablas cubiertas: SOLO las del dominio del inbox. Quedan fuera:
 * - Tenant, MetaApp, WebhookEvent: plataforma.
 * - WhatsappAccount: el webhook la busca por phoneNumberId global PARA
 *   resolver el tenant — no puede exigir lo que está tratando de averiguar.
 * - User: el login busca por email antes de conocer el tenant.
 * - Session: se busca por tokenHash ANTES de conocer el tenant (es la que
 *   RESPONDE cuál es el tenant); el scoping del dominio arranca después.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Contact',
  'Conversation',
  'Message',
  'MessageTemplate',
  'QuickReply',
  'GourmetifyOrder',
]);

export class MissingTenantScopeError extends Error {
  constructor(model: string, operation: string, detail: string) {
    super(
      `Query sin tenant scope: ${model}.${operation} — ${detail}. ` +
        `Toda query del dominio debe incluir tenantId explícito.`,
    );
    this.name = 'MissingTenantScopeError';
  }
}

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Acepta tenantId como string directo o como filtro { equals: '...' }. */
function tenantIdPresent(value: unknown): boolean {
  if (typeof value === 'string' && value.length > 0) return true;
  if (isPlainObject(value) && typeof value.equals === 'string' && value.equals.length > 0) {
    return true;
  }
  return false;
}

/**
 * ¿El where está scopeado por tenant? Formas aceptadas:
 * - { tenantId: 'abc' }                       — filtro directo
 * - { tenantId: { equals: 'abc' } }           — filtro con operador
 * - { tenantId_waId: { tenantId, waId } }     — unique compuesto
 * - { AND: [{ tenantId: 'abc' }, ...] }       — dentro de un AND (recursivo)
 *
 * Un tenantId solo dentro de OR/NOT NO cuenta: no garantiza el scope de
 * todas las ramas.
 */
export function hasTenantScope(where: unknown): boolean {
  if (!isPlainObject(where)) return false;
  if (tenantIdPresent(where.tenantId)) return true;

  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      const branches = Array.isArray(value) ? value : [value];
      if (branches.some((branch) => hasTenantScope(branch))) return true;
    } else if (
      key.includes('tenantId') && // uniques compuestos: tenantId_waId, tenantId_wamid, ...
      isPlainObject(value) &&
      tenantIdPresent(value.tenantId)
    ) {
      return true;
    }
  }
  return false;
}

/** ¿El data de un create trae tenant? (FK escalar o connect de relación) */
function dataHasTenant(data: unknown): boolean {
  if (!isPlainObject(data)) return false;
  if (typeof data.tenantId === 'string' && data.tenantId.length > 0) return true;
  const tenant = data.tenant;
  if (isPlainObject(tenant) && isPlainObject(tenant.connect)) {
    const connect = tenant.connect as Dict;
    if (typeof connect.id === 'string' || typeof connect.slug === 'string') return true;
  }
  return false;
}

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Valida una operación contra un modelo del dominio. Exportada como función
 * pura para poder testearla sin cliente Prisma.
 */
export function assertTenantScoped(model: string, operation: string, args: unknown): void {
  if (!TENANT_SCOPED_MODELS.has(model)) return;

  const a = isPlainObject(args) ? args : {};

  if (WHERE_OPS.has(operation)) {
    if (!hasTenantScope(a.where)) {
      throw new MissingTenantScopeError(model, operation, 'where sin tenantId');
    }
    return;
  }

  if (CREATE_OPS.has(operation)) {
    const data = a.data;
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0 || !rows.every(dataHasTenant)) {
      throw new MissingTenantScopeError(model, operation, 'data sin tenantId');
    }
    return;
  }

  if (operation === 'upsert') {
    if (!hasTenantScope(a.where)) {
      throw new MissingTenantScopeError(model, operation, 'where sin tenantId');
    }
    if (!dataHasTenant(a.create)) {
      throw new MissingTenantScopeError(model, operation, 'create sin tenantId');
    }
    return;
  }

  // Fail-closed: una operación que este guardia no conoce no pasa sin
  // revisión. Si Prisma agrega una op nueva, se agrega acá a conciencia.
  throw new MissingTenantScopeError(
    model,
    operation,
    'operación no contemplada por el tenant guard',
  );
}

export const tenantGuardExtension = Prisma.defineExtension({
  name: 'tenant-guard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        assertTenantScoped(model, operation, args);
        return query(args);
      },
    },
  },
});
