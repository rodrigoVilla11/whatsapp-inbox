import type { GourmetifyOrder } from './types';

/**
 * Presentación del estado de pedido (statusKind → clases del sistema).
 * REGLA: gari NO se usa acá — sigue reservado a ventana/FAILED/conexión.
 * pending = tinta fuerte (pide acción), in_progress = nori suave,
 * ready = nori sólido, done/cancelled = piedra.
 */
export function orderChipClasses(kind: string): string {
  switch (kind) {
    case 'pending':
      return 'border border-sumi bg-rice font-semibold text-sumi';
    case 'in_progress':
      return 'bg-nori-soft font-medium text-nori';
    case 'ready':
      return 'bg-nori font-semibold text-rice';
    case 'done':
      return 'bg-piedra-soft text-sumi/60';
    case 'cancelled':
      return 'bg-piedra-soft text-sumi/50 line-through';
    default:
      return 'bg-piedra-soft text-sumi/60'; // kind desconocido: neutro, jamás romper
  }
}

/** El pedido activo a mostrar en el chip del header: el más reciente. */
export function activeOrderChip(active: readonly GourmetifyOrder[]): {
  order: GourmetifyOrder;
  extra: number;
} | null {
  if (active.length === 0) return null;
  return { order: active[0], extra: active.length - 1 };
}

// ── Merge del evento order.updated (puro, testeable) ────────────────────

export interface OrdersBundle {
  active: GourmetifyOrder[];
  recent: GourmetifyOrder[];
}

const ACTIVE_KINDS: ReadonlySet<string> = new Set(['pending', 'in_progress', 'ready']);
const RECENT_LIMIT = 3;

export function isActiveOrderKind(kind: string): boolean {
  return ACTIVE_KINDS.has(kind);
}

function byCreatedDesc(a: GourmetifyOrder, b: GourmetifyOrder): number {
  return Date.parse(b.orderCreatedAt) - Date.parse(a.orderCreatedAt);
}

/**
 * Upsert de un pedido en el bundle: lo saca de donde esté (un cambio de
 * kind lo puede mover de activos a cerrados) y lo re-inserta en la lista
 * que corresponde, ordenado desc y con los cerrados capados a 3.
 */
export function mergeOrder(
  bundle: OrdersBundle | undefined,
  order: GourmetifyOrder,
): OrdersBundle {
  const active = (bundle?.active ?? []).filter((o) => o.id !== order.id);
  const recent = (bundle?.recent ?? []).filter((o) => o.id !== order.id);
  if (ACTIVE_KINDS.has(order.statusKind)) {
    return { active: [...active, order].sort(byCreatedDesc), recent };
  }
  return {
    active,
    recent: [...recent, order].sort(byCreatedDesc).slice(0, RECENT_LIMIT),
  };
}
