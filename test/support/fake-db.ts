/**
 * Fake in-memory del subset de Prisma que usa el worker. Permite tests de
 * comportamiento (idempotencia, contadores, avance monotónico) hermé­ticos,
 * sin Postgres. Implementa:
 * - uniques con violación { code: 'P2002' } (como detecta el código real)
 * - upsert atómico por unique compuesto
 * - updateMany con where de igualdad, null, OR, in, not, lt/lte
 * - data con { increment } y campos directos
 * - $transaction(fn) → fn(mismo fake)
 */

type Row = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

const OPERATOR_KEYS = [
  'equals',
  'in',
  'notIn',
  'not',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'startsWith',
];

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && Object.keys(v).some((k) => OPERATOR_KEYS.includes(k));
}

function comparable(v: unknown): number | string {
  return v instanceof Date ? v.getTime() : (v as number | string);
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a != null && b != null && new Date(a as Date).getTime() === new Date(b as Date).getTime();
  }
  return a === b;
}

function matchOperator(rowValue: unknown, op: Record<string, unknown>): boolean {
  if ('equals' in op && !valueEquals(rowValue, op.equals)) return false;
  if ('in' in op && !(op.in as unknown[]).some((x) => valueEquals(rowValue, x))) return false;
  if ('notIn' in op && (op.notIn as unknown[]).some((x) => valueEquals(rowValue, x))) return false;
  if ('not' in op) {
    const n = op.not;
    if (n === null) {
      if (rowValue == null) return false;
    } else if (isOperatorObject(n)) {
      if (matchOperator(rowValue, n)) return false;
    } else if (valueEquals(rowValue, n)) {
      return false;
    }
  }
  if ('contains' in op || 'startsWith' in op) {
    // Semántica Prisma: mode 'insensitive' → ILIKE. NULL nunca matchea.
    if (typeof rowValue !== 'string') return false;
    const fold = (s: string): string => (op.mode === 'insensitive' ? s.toLowerCase() : s);
    if ('contains' in op && !fold(rowValue).includes(fold(String(op.contains)))) return false;
    if ('startsWith' in op && !fold(rowValue).startsWith(fold(String(op.startsWith)))) return false;
  }
  if ('lt' in op && !(rowValue != null && comparable(rowValue) < comparable(op.lt))) return false;
  if ('lte' in op && !(rowValue != null && comparable(rowValue) <= comparable(op.lte))) return false;
  if ('gt' in op && !(rowValue != null && comparable(rowValue) > comparable(op.gt))) return false;
  if ('gte' in op && !(rowValue != null && comparable(rowValue) >= comparable(op.gte))) return false;
  return true;
}

/**
 * Filtro de RELACIÓN (`tags: { some: {...} }`): el fake no conoce el grafo,
 * así que cada modelo declara cómo resolver los suyos con setRelation(). Se
 * pasa por toda la recursión porque en la práctica aparecen dentro de un OR
 * (la búsqueda matchea "por contacto O por etiqueta").
 */
export type RelationMatcher = (row: Row, condition: unknown) => boolean;

export function matchWhere(
  row: Row,
  where: Row | undefined,
  relations: Record<string, RelationMatcher> = {},
): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matchWhere(row, w, relations))) return false;
      continue;
    }
    if (key === 'AND') {
      const branches = Array.isArray(cond) ? cond : [cond];
      if (!branches.every((w) => matchWhere(row, w as Row, relations))) return false;
      continue;
    }
    if (key === 'NOT') {
      const branches = Array.isArray(cond) ? cond : [cond];
      if (branches.some((w) => matchWhere(row, w as Row, relations))) return false;
      continue;
    }
    if (relations[key]) {
      if (!relations[key](row, cond)) return false;
      continue;
    }
    if (cond === null) {
      if (row[key] != null) return false;
      continue;
    }
    // Filtro vacío ({} — p.ej. WITH_DELETED): en Prisma matchea todo.
    if (isPlainObject(cond) && Object.keys(cond).length === 0) {
      continue;
    }
    if (isOperatorObject(cond)) {
      if (!matchOperator(row[key], cond)) return false;
      continue;
    }
    if (isPlainObject(cond) && key.includes('_')) {
      // unique compuesto: { tenantId_waId: { tenantId, waId } }
      if (!matchWhere(row, cond)) return false;
      continue;
    }
    if (!valueEquals(row[key], cond)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && 'increment' in value) {
      row[key] = ((row[key] as number) ?? 0) + (value.increment as number);
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

export class FakeModel {
  rows: Row[] = [];
  private seq = 0;
  private relations: Record<string, RelationMatcher> = {};
  private includes: Record<string, (row: Row) => Row | null> = {};

  constructor(
    private readonly name: string,
    private readonly defaults: Row = {},
    private readonly uniques: string[][] = [],
  ) {}

  /** Declara cómo se evalúa un filtro de relación (`tags: { some: … }`). */
  setRelation(field: string, matcher: RelationMatcher): this {
    this.relations[field] = matcher;
    return this;
  }

  /** Declara cómo se resuelve un `include: { tag: true }`. */
  setInclude(field: string, resolve: (row: Row) => Row | null): this {
    this.includes[field] = resolve;
    return this;
  }

  private matches(row: Row, where: Row | undefined): boolean {
    return matchWhere(row, where, this.relations);
  }

  private withIncludes(row: Row, include: Row | undefined): Row {
    if (!include) return { ...row };
    const out: Row = { ...row };
    for (const [field, wanted] of Object.entries(include)) {
      if (wanted && this.includes[field]) {
        const related = this.includes[field](row);
        out[field] = related ? { ...related } : null;
      }
    }
    return out;
  }

  seed(row: Row): Row {
    const full = { id: `${this.name}_${++this.seq}`, ...this.defaults, ...row };
    this.rows.push(full);
    return full;
  }

  private checkUniques(candidate: Row, ignore?: Row): void {
    for (const fields of this.uniques) {
      if (fields.some((f) => candidate[f] == null)) continue; // NULLs no colisionan
      const clash = this.rows.find(
        (r) => r !== ignore && fields.every((f) => valueEquals(r[f], candidate[f])),
      );
      if (clash) {
        const error = new Error(
          `Unique constraint failed on (${fields.join(', ')})`,
        ) as Error & { code: string };
        error.code = 'P2002';
        throw error;
      }
    }
  }

  create({ data }: { data: Row }): Row {
    // Semántica Prisma: `campo: undefined` = "no provisto" → aplica default.
    const provided = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined),
    );
    const row: Row = {
      id: `${this.name}_${++this.seq}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...structuredClone(this.defaults),
      ...structuredClone(provided),
    };
    this.checkUniques(row);
    this.rows.push(row);
    return { ...row };
  }

  findUnique({ where }: { where: Row }): Row | null {
    return this.findFirst({ where });
  }

  findFirst({ where }: { where?: Row } = {}): Row | null {
    const row = this.rows.find((r) => this.matches(r, where));
    return row ? { ...row } : null;
  }

  findMany({
    where,
    orderBy,
    take,
    include,
    select,
  }: {
    where?: Row;
    orderBy?: Row | Row[];
    take?: number;
    include?: Row;
    select?: Row;
  } = {}): Row[] {
    let rows = this.rows.filter((r) => this.matches(r, where));
    if (orderBy) {
      const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) =>
        Object.entries(o).map(([field, dir]) => {
          const d = isPlainObject(dir) ? dir : { sort: dir };
          return {
            field,
            desc: d.sort === 'desc',
            nullsLast: d.nulls === 'last' || (d.nulls === undefined && d.sort === 'desc'),
          };
        }),
      );
      rows = [...rows].sort((a, b) => {
        for (const spec of specs) {
          const av = a[spec.field];
          const bv = b[spec.field];
          if (av == null && bv == null) continue;
          if (av == null) return spec.nullsLast ? 1 : -1;
          if (bv == null) return spec.nullsLast ? -1 : 1;
          const ca = comparable(av);
          const cb = comparable(bv);
          if (ca === cb) continue;
          const cmp = ca < cb ? -1 : 1;
          return spec.desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (take !== undefined) rows = rows.slice(0, take);
    return rows.map((r) => {
      const withRelations = this.withIncludes(r, include);
      if (!select) return withRelations;
      // `select` en Prisma devuelve SOLO los campos pedidos.
      return Object.fromEntries(
        Object.keys(select)
          .filter((k) => select[k])
          .map((k) => [k, withRelations[k]]),
      );
    });
  }

  /** Subset de groupBy: by (campos) + _count._all. Es lo que usa el dominio. */
  groupBy({
    by,
    where,
  }: {
    by: string[];
    where?: Row;
    _count?: unknown;
  }): Array<Row & { _count: { _all: number } }> {
    const buckets = new Map<string, { key: Row; count: number }>();
    for (const row of this.rows.filter((r) => this.matches(r, where))) {
      const key = Object.fromEntries(by.map((f) => [f, row[f]]));
      const hash = JSON.stringify(by.map((f) => row[f]));
      const bucket = buckets.get(hash) ?? { key, count: 0 };
      bucket.count += 1;
      buckets.set(hash, bucket);
    }
    return [...buckets.values()].map((b) => ({ ...b.key, _count: { _all: b.count } }));
  }

  update({ where, data }: { where: Row; data: Row }): Row {
    const row = this.rows.find((r) => this.matches(r, where));
    if (!row) {
      const error = new Error('Record not found') as Error & { code: string };
      error.code = 'P2025';
      throw error;
    }
    applyData(row, data);
    this.checkUniques(row, row);
    return { ...row };
  }

  updateMany({ where, data }: { where?: Row; data: Row }): { count: number } {
    const matched = this.rows.filter((r) => this.matches(r, where));
    for (const row of matched) applyData(row, data);
    return { count: matched.length };
  }

  upsert({ where, create, update }: { where: Row; create: Row; update: Row }): Row {
    const existing = this.rows.find((r) => this.matches(r, where));
    if (existing) {
      applyData(existing, update);
      return { ...existing };
    }
    return this.create({ data: create });
  }

  deleteMany({ where }: { where?: Row } = {}): { count: number } {
    const keep = this.rows.filter((r) => !this.matches(r, where));
    const count = this.rows.length - keep.length;
    this.rows = keep;
    return { count };
  }
}

export interface FakeDb {
  tenant: FakeModel;
  metaApp: FakeModel;
  whatsappAccount: FakeModel;
  user: FakeModel;
  session: FakeModel;
  webhookEvent: FakeModel;
  contact: FakeModel;
  conversation: FakeModel;
  message: FakeModel;
  messageTemplate: FakeModel;
  quickReply: FakeModel;
  gourmetifyOrder: FakeModel;
  tag: FakeModel;
  conversationTag: FakeModel;
  // Las dos formas de Prisma: callback (interactive) y array (batch).
  $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T>;
  $transaction<T>(operations: T[]): Promise<T[]>;
}

export function createFakeDb(): FakeDb {
  const db: FakeDb = {
    tenant: new FakeModel(
      'ten',
      {
        status: 'ACTIVE',
        timezone: 'America/Argentina/Buenos_Aires',
        gourmetifyTenantId: null,
        autoReply: null,
      },
      [['slug'], ['gourmetifyTenantId']],
    ),
    metaApp: new FakeModel('app', { graphVersion: null }, [['ref'], ['appId']]),
    whatsappAccount: new FakeModel('acc', {}, [['phoneNumberId']]),
    user: new FakeModel(
      'user',
      {
        role: 'AGENT',
        isActive: true,
        gourmetifyUserId: null,
        passwordHash: null,
        mustChangePassword: false,
      },
      [['tenantId', 'email']],
    ),
    session: new FakeModel('ses', { userAgent: null }, [['tokenHash']]),
    webhookEvent: new FakeModel('evt', {
      tenantId: null,
      whatsappAccountId: null,
      phoneNumberId: null,
      error: null,
      processedAt: null,
    }),
    contact: new FakeModel(
      'contact',
      { profileName: null, phoneE164: null, notes: null, isBlocked: false, customerId: null, deletedAt: null },
      [['tenantId', 'waId']],
    ),
    conversation: new FakeModel(
      'conv',
      {
        status: 'OPEN',
        assignedUserId: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastAutoReplyAt: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        unreadCount: 0,
        pinnedAt: null,
        orderId: null,
        deletedAt: null,
      },
      [['tenantId', 'whatsappAccountId', 'contactId']],
    ),
    message: new FakeModel(
      'msg',
      {
        wamid: null,
        clientDedupKey: null,
        status: 'PENDING',
        body: null,
        replyToWamid: null,
        mediaId: null,
        mediaMimeType: null,
        mediaFilename: null,
        mediaSha256: null,
        mediaStatus: null,
        transcription: null,
        isAutoReply: false,
        billable: null,
        pricingModel: null,
        pricingCategory: null,
        pricingType: null,
        errorCode: null,
        errorTitle: null,
        errorDetail: null,
        deliveredAt: null,
        readAt: null,
        failedAt: null,
        raw: null,
        deletedAt: null,
      },
      [['tenantId', 'wamid'], ['tenantId', 'clientDedupKey']],
    ),
    messageTemplate: new FakeModel(
      'tpl',
      { status: 'PENDING', components: null, variableCount: 0, metaTemplateId: null, syncedAt: null },
      [['tenantId', 'whatsappAccountId', 'name', 'language']],
    ),
    quickReply: new FakeModel('qr', { isActive: true, isFavorite: false }, [
      ['tenantId', 'shortcut'],
    ]),
    gourmetifyOrder: new FakeModel(
      'gord',
      {
        contactId: null,
        number: null,
        summary: null,
        totalLabel: null,
        deliveryLabel: null,
        scheduledLabel: null,
      },
      [['tenantId', 'gourmetifyOrderId']],
    ),
    tag: new FakeModel('tag', { color: 'piedra' }, [['tenantId', 'slug']]),
    // El @@id([conversationId, tagId]) del schema funciona como unique.
    conversationTag: new FakeModel('convtag', {}, [['conversationId', 'tagId']]),
    $transaction: (async (arg: unknown) =>
      // Forma array: en el fake las operaciones ya se ejecutaron al armar el
      // array (son sincrónicas), así que solo hay que resolverlas.
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: FakeDb) => Promise<unknown>)(db)) as FakeDb['$transaction'],
  };

  // Relaciones que el dominio consulta: filtro `tags: { some: … }` sobre
  // conversaciones, y `include: { tag: true }` sobre el join.
  db.conversation.setRelation('tags', (row, condition) => {
    const some = (condition as { some?: Row } | null)?.some;
    if (!some) return true;
    return db.conversationTag.rows.some(
      (ct) => ct.conversationId === row.id && matchWhere(ct, some),
    );
  });
  db.conversationTag.setInclude(
    'tag',
    (row) => db.tag.rows.find((t) => t.id === row.tagId) ?? null,
  );

  return db;
}
