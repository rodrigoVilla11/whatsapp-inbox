/**
 * Pedidos en el chat (lado UI): merge puro del evento order.updated,
 * mapeo statusKind → clases (gari JAMÁS), y estabilidad de referencia del
 * selector (regla permanente de selectores del store).
 */
import { describe, expect, it } from 'vitest';
import { activeOrderChip, mergeOrder, orderChipClasses, type OrdersBundle } from '../src/lib/order-ui';
import { EMPTY_ORDERS, selectOrders } from '../src/lib/selectors';
import type { GourmetifyOrder } from '../src/lib/types';

let seq = 0;
function order(over: Partial<GourmetifyOrder> = {}): GourmetifyOrder {
  seq += 1;
  return {
    id: `o${seq}`,
    gourmetifyOrderId: `g${seq}`,
    contactId: 'ct1',
    number: String(100 + seq),
    statusLabel: 'En preparación',
    statusKind: 'in_progress',
    summary: null,
    totalLabel: null,
    deliveryLabel: null,
    scheduledLabel: null,
    orderCreatedAt: `2026-07-28T20:0${seq % 10}:00Z`,
    ...over,
  };
}

describe('orderChipClasses', () => {
  it('cada kind tiene su clase y NINGUNO usa gari (reservado a urgencia)', () => {
    const kinds = ['pending', 'in_progress', 'ready', 'done', 'cancelled'];
    for (const kind of kinds) {
      const classes = orderChipClasses(kind);
      expect(classes).toBeTruthy();
      expect(classes).not.toMatch(/gari/); // la regla un-color-un-significado
    }
    expect(orderChipClasses('ready')).toMatch(/bg-nori /);
    expect(orderChipClasses('cancelled')).toMatch(/line-through/);
  });

  it('kind desconocido → neutro piedra, jamás romper', () => {
    expect(orderChipClasses('lo-que-mande-el-futuro')).toMatch(/piedra/);
  });
});

describe('mergeOrder', () => {
  it('inserta activos ordenados desc por fecha', () => {
    const a = order({ id: 'a', orderCreatedAt: '2026-07-28T20:00:00Z' });
    const b = order({ id: 'b', orderCreatedAt: '2026-07-28T21:00:00Z' });
    const bundle = mergeOrder(mergeOrder(undefined, a), b);
    expect(bundle.active.map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('upsert: el mismo id no duplica, actualiza', () => {
    const v1 = order({ id: 'x', statusLabel: 'Pendiente', statusKind: 'pending' });
    const v2 = { ...v1, statusLabel: 'Listo', statusKind: 'ready' as const };
    const bundle = mergeOrder(mergeOrder(undefined, v1), v2);
    expect(bundle.active).toHaveLength(1);
    expect(bundle.active[0].statusLabel).toBe('Listo');
  });

  it('cambio de kind a done MUEVE el pedido de activos a cerrados', () => {
    const activo = order({ id: 'm', statusKind: 'ready' });
    let bundle = mergeOrder(undefined, activo);
    expect(bundle.active).toHaveLength(1);

    bundle = mergeOrder(bundle, { ...activo, statusKind: 'done', statusLabel: 'Entregado' });
    expect(bundle.active).toHaveLength(0);
    expect(bundle.recent.map((o) => o.id)).toEqual(['m']);
  });

  it('cerrados capados a 3, quedan los más nuevos', () => {
    let bundle: OrdersBundle | undefined;
    for (let i = 1; i <= 5; i++) {
      bundle = mergeOrder(
        bundle,
        order({ id: `d${i}`, statusKind: 'done', orderCreatedAt: `2026-07-2${i}T10:00:00Z` }),
      );
    }
    expect(bundle!.recent.map((o) => o.id)).toEqual(['d5', 'd4', 'd3']);
  });
});

describe('activeOrderChip', () => {
  it('sin activos → null; con varios → el más reciente + contador', () => {
    expect(activeOrderChip([])).toBeNull();
    const chip = activeOrderChip([order({ id: 'r1' }), order({ id: 'r2' })]);
    expect(chip!.order.id).toBe('r1');
    expect(chip!.extra).toBe(1);
  });
});

describe('selectOrders (contrato de referencia estable)', () => {
  it('sin datos devuelve SIEMPRE la misma referencia (jamás literal nuevo)', () => {
    const state = { orders: {} as Record<string, OrdersBundle> };
    const selector = selectOrders('ct1');
    expect(selector(state)).toBe(EMPTY_ORDERS);
    expect(selector(state)).toBe(selector(state)); // dos evaluaciones, misma ref
    expect(selectOrders(null)(state)).toBe(EMPTY_ORDERS);
  });

  it('con datos devuelve la referencia del estado tal cual', () => {
    const bundle: OrdersBundle = { active: [order()], recent: [] };
    const state = { orders: { ct1: bundle } };
    expect(selectOrders('ct1')(state)).toBe(bundle);
  });
});
