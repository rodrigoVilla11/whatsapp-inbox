import { describe, expect, it } from 'vitest';
import { WITH_DELETED, expandUniqueWhere, injectDeletedFilter } from '../src/prisma/soft-delete';

describe('injectDeletedFilter', () => {
  it('inyecta deletedAt: null cuando el where no lo menciona', () => {
    expect(injectDeletedFilter({ where: { tenantId: 't' } })).toEqual({
      where: { tenantId: 't', deletedAt: null },
    });
  });

  it('crea el where si no existe (count() sin args)', () => {
    expect(injectDeletedFilter(undefined)).toEqual({ where: { deletedAt: null } });
  });

  it('respeta un deletedAt explícito del caller', () => {
    const soloBorrados = { where: { tenantId: 't', deletedAt: { not: null } } };
    expect(injectDeletedFilter(soloBorrados)).toEqual(soloBorrados);

    const conBorrados = { where: { tenantId: 't', ...WITH_DELETED } };
    expect(injectDeletedFilter(conBorrados)).toEqual(conBorrados);
  });

  it('no pisa el resto de los args', () => {
    const args = { where: { tenantId: 't' }, take: 10, select: { id: true } };
    expect(injectDeletedFilter(args)).toEqual({
      where: { tenantId: 't', deletedAt: null },
      take: 10,
      select: { id: true },
    });
  });
});

describe('expandUniqueWhere', () => {
  it('aplana uniques compuestos para el redirect findUnique → findFirst', () => {
    expect(expandUniqueWhere({ tenantId_waId: { tenantId: 't', waId: 'w' } })).toEqual({
      tenantId: 't',
      waId: 'w',
    });
  });

  it('copia campos simples tal cual', () => {
    expect(expandUniqueWhere({ id: 'c_1' })).toEqual({ id: 'c_1' });
  });
});
