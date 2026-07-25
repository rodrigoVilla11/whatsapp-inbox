import { Prisma } from '@prisma/client';

/**
 * Soft delete con filtro por defecto en las LECTURAS del dominio.
 *
 * - findMany / findFirst / count / aggregate / groupBy: si el where no
 *   menciona deletedAt, se inyecta deletedAt: null.
 * - findUnique(OrThrow): el where unique no admite deletedAt, así que se
 *   redirige a findFirst(OrThrow) expandiendo el unique compuesto
 *   ({ tenantId_waId: {...} } → { tenantId, waId, deletedAt: null }).
 *   El redirect pasa por el tenant guard igual que cualquier findFirst.
 * - Escrituras (update/delete/upsert): NO se filtran — restaurar y purgar
 *   necesitan alcanzar filas borradas.
 *
 * Para incluir borrados a propósito: WITH_DELETED en el where
 * (`where: { tenantId, ...WITH_DELETED }`) — la clave deletedAt presente
 * desactiva la inyección.
 */
export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([
  'Contact',
  'Conversation',
  'Message',
]);

/** Filtro vacío: matchea borrados y no borrados. */
export const WITH_DELETED = { deletedAt: {} } as const;

const FILTERED_READ_OPS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);

type Dict = Record<string, unknown>;

function hasKey(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Función pura, testeable: inyecta deletedAt: null si el where no lo menciona. */
export function injectDeletedFilter(args: Dict | undefined): Dict {
  const a: Dict = { ...(args ?? {}) };
  const where = (a.where ?? {}) as Dict;
  if (!hasKey(where, 'deletedAt')) {
    a.where = { ...where, deletedAt: null };
  }
  return a;
}

/**
 * Expande un where de findUnique a uno de findFirst:
 * { tenantId_waId: { tenantId, waId } } → { tenantId, waId }
 * Los valores objeto bajo clave con '_' son uniques compuestos generados
 * por Prisma; el resto se copia tal cual.
 */
export function expandUniqueWhere(where: Dict): Dict {
  const out: Dict = {};
  for (const [key, value] of Object.entries(where)) {
    if (key.includes('_') && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const softDeleteExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'soft-delete-default-filter',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!SOFT_DELETE_MODELS.has(model)) return query(args);

          if (FILTERED_READ_OPS.has(operation)) {
            return query(injectDeletedFilter(args as Dict) as typeof args);
          }

          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            const a = (args ?? {}) as Dict;
            const where = expandUniqueWhere((a.where ?? {}) as Dict);
            if (!hasKey(where, 'deletedAt')) where.deletedAt = null;
            // `client` es el cliente previo en la cadena (incluye el tenant
            // guard), así que el redirect queda validado igual.
            const delegate = (client as Record<string, any>)[
              model.charAt(0).toLowerCase() + model.slice(1)
            ];
            const method = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
            return delegate[method]({ ...a, where });
          }

          return query(args);
        },
      },
    },
  }),
);
