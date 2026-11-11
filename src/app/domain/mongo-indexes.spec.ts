import { emptyIndexForm, explainable, formatBytes, indexRequest, indexView } from './mongo-indexes';
import { WriteTextError } from './mongo-write';

const int = (n: number) => ({ $numberInt: String(n) });

describe('indexes', () => {
  it('says what each index is from its definition', () => {
    expect(indexView({ name: '_id_', spec: { v: int(2), key: { _id: int(1) } } })).toEqual({
      name: '_id_',
      keys: '{ _id: 1 }',
      kinds: [],
      hidden: false,
      id: true,
    });
    expect(
      indexView({
        name: 'status_1_at_-1',
        spec: {
          key: { status: int(1), at: int(-1) },
          unique: true,
          partialFilterExpression: { status: { $exists: true } },
          hidden: true,
        },
      }),
    ).toMatchObject({
      keys: '{ status: 1, at: -1 }',
      kinds: ['Compound', 'Unique', 'Partial', 'Hidden'],
      partial: '{ status: { $exists: true } }',
      hidden: true,
      id: false,
    });
    expect(
      indexView({ name: 'at_1', spec: { key: { at: int(1) }, expireAfterSeconds: int(3600) } }),
    ).toMatchObject({ kinds: ['TTL'], ttl: 3600 });
    // A text index searches the fields of its weights, as one index.
    expect(
      indexView({
        name: 'title_text_body_text',
        spec: { key: { _fts: 'text', _ftsx: int(1) }, weights: { title: int(10), body: int(1) } },
      }),
    ).toMatchObject({ keys: '{ title: "text", body: "text" }', kinds: ['Text'] });
    expect(
      indexView({ name: 'loc', spec: { key: { loc: '2dsphere' }, sparse: true } }).kinds,
    ).toEqual(['Sparse', 'Geospatial']);
    expect(indexView({ name: 'w', spec: { key: { 'a.$**': int(1) } } }).kinds).toEqual([
      'Wildcard',
    ]);
    expect(indexView({ name: 'h', spec: { key: { a: 'hashed' } } }).kinds).toEqual(['Hashed']);
    expect(indexView({ name: 'broken', spec: {} })).toMatchObject({ keys: '{}', kinds: [] });
  });

  it('builds a new index from its form, and says what to correct', () => {
    expect(
      indexRequest({
        ...emptyIndexForm(),
        keys: '{ status: 1, at: -1 }',
        name: ' by_status ',
        unique: true,
        hidden: true,
        partial: "{ status: { $in: ['A', 'B'] } }",
        options: "{ collation: { locale: 'es' } }",
      }),
    ).toEqual({
      keys: { status: 1, at: -1 },
      options: {
        collation: { locale: 'es' },
        name: 'by_status',
        unique: true,
        hidden: true,
        partialFilterExpression: { status: { $in: ['A', 'B'] } },
      },
    });
    expect(indexRequest({ ...emptyIndexForm(), keys: '{ at: 1 }', ttl: '3600' }).options).toEqual({
      expireAfterSeconds: 3600,
    });
    const problem = (form: Partial<ReturnType<typeof emptyIndexForm>>) => {
      try {
        indexRequest({ ...emptyIndexForm(), ...form });
        return '';
      } catch (error) {
        return error instanceof WriteTextError ? error.key : String(error);
      }
    };
    expect(problem({ keys: ' ' })).toBe('mongo.indexKeys');
    expect(problem({ keys: '{}' })).toBe('mongo.indexKeys');
    expect(problem({ keys: '[1]' })).toBe('mongo.indexKeys');
    expect(problem({ keys: '{ a: 1 }', ttl: '-5' })).toBe('mongo.notCount');
    expect(problem({ keys: '{ a: 1 }', partial: '1' })).toBe('mongo.notDocument');
    expect(problem({ keys: '{ a: ' })).toBe('mongo.syntax');
  });

  it('writes sizes in the largest unit', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(36864)).toBe('36.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('profiled operations', () => {
  const entry = (command: Record<string, unknown> | undefined, ns = 'shop.orders') => ({
    op: 'query',
    ns,
    millis: 120,
    ...(command ? { command } : {}),
  });

  it('explains again a recorded find, with its fields and types', () => {
    expect(
      explainable(
        entry({
          find: 'orders',
          filter: { at: { $gte: { $date: { $numberLong: '1704067200000' } } } },
          sort: { at: int(-1) },
          projection: {},
          skip: int(0),
          limit: { $numberLong: '10' },
          hint: 'at_-1',
          $db: 'shop',
        }),
      ),
    ).toEqual({
      database: 'shop',
      collection: 'orders',
      query: {
        filter: { at: { $gte: { $date: { $numberLong: '1704067200000' } } } },
        sort: { at: int(-1) },
        hint: 'at_-1',
        limit: 10,
      },
    });
  });

  it('explains a recorded aggregation that does not write, and nothing else', () => {
    expect(
      explainable(
        entry({ aggregate: 'orders', pipeline: [{ $match: { a: int(1) } }] }, 'shop.$cmd'),
      ),
    ).toEqual({ database: 'shop', collection: 'orders', pipeline: [{ $match: { a: int(1) } }] });
    expect(
      explainable(entry({ aggregate: 'orders', pipeline: [{ $out: 'copy' }] })),
    ).toBeUndefined();
    expect(explainable(entry({ aggregate: int(1), pipeline: [] }))).toBeUndefined();
    expect(explainable(entry({ insert: 'orders', documents: [] }))).toBeUndefined();
    expect(explainable(entry(undefined))).toBeUndefined();
  });
});
