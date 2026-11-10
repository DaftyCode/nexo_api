import {
  QueryFieldError,
  QuerySyntaxError,
  buildQuery,
  emptyQueryForm,
  queryValue,
  querySummary,
  shellToExtendedJson,
} from './mongo-query';

describe('MongoDB queries in shell syntax', () => {
  const cases: [string, unknown][] = [
    ['{}', {}],
    ['{"a": 1}', { a: 1 }],
    ["{status: 'A', qty: {$lt: 30}}", { status: 'A', qty: { $lt: 30 } }],
    ['{customer.address.city: "Madrid"}', { 'customer.address.city': 'Madrid' }],
    ['{_id: ObjectId("65A1B2C3D4E5F6A7B8C9D0E1")}', { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' } }],
    [
      "{at: {$gte: ISODate('2024-01-02T03:04:05.006Z')}}",
      { at: { $gte: { $date: { $numberLong: '1704164645006' } } } },
    ],
    ['{at: new Date(0)}', { at: { $date: { $numberLong: '0' } } }],
    ["{n: NumberLong('9007199254740993')}", { n: { $numberLong: '9007199254740993' } }],
    ['{n: NumberLong(5)}', { n: { $numberLong: '5' } }],
    ['{n: 9007199254740993}', { n: { $numberLong: '9007199254740993' } }],
    ['{n: NumberInt(7), m: Int32("8")}', { n: { $numberInt: '7' }, m: { $numberInt: '8' } }],
    [
      '{n: 2.0, m: 2.5, e: 1e3, x: -4}',
      { n: { $numberDouble: '2.0' }, m: 2.5, e: { $numberDouble: '1000.0' }, x: -4 },
    ],
    ["{p: NumberDecimal('1.10')}", { p: { $numberDecimal: '1.10' } }],
    ["{b: BinData(0, 'AQID')}", { b: { $binary: { base64: 'AQID', subType: '00' } } }],
    ["{h: HexData(5, '0a0b')}", { h: { $binary: { base64: 'Cgs=', subType: '05' } } }],
    [
      "{u: UUID('3b241101-e2bb-4255-8caf-4136c566a962')}",
      { u: { $binary: { base64: 'OyQRAeK7QlWMr0E2xWapYg==', subType: '04' } } },
    ],
    ['{name: /^ab\\/c/mi}', { name: { $regularExpression: { pattern: '^ab/c', options: 'im' } } }],
    [
      "{name: RegExp('a[/]b', 'i')}",
      { name: { $regularExpression: { pattern: 'a[/]b', options: 'i' } } },
    ],
    ['{t: Timestamp({t: 1700000000, i: 1})}', { t: { $timestamp: { t: 1700000000, i: 1 } } }],
    ['{t: Timestamp(5, 2)}', { t: { $timestamp: { t: 5, i: 2 } } }],
    ['{a: MinKey(), b: MaxKey()}', { a: { $minKey: 1 }, b: { $maxKey: 1 } }],
    [
      '{a: null, b: true, c: false, d: undefined}',
      { a: null, b: true, c: false, d: { $undefined: true } },
    ],
    ['{a: [1, "x", {b: []},]}', { a: [1, 'x', { b: [] }] }],
    ["{s: 'it\\'s \\u00e9\\n'}", { s: "it's é\n" }],
    ['// first\n{a: /* inline */ 1}', { a: 1 }],
    ['{"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}', { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }],
    ['{d: {"$date": "2024-01-01T00:00:00Z"}}', { d: { $date: '2024-01-01T00:00:00Z' } }],
    [
      '{n: Infinity, m: -Infinity, z: NaN}',
      {
        n: { $numberDouble: 'Infinity' },
        m: { $numberDouble: '-Infinity' },
        z: { $numberDouble: 'NaN' },
      },
    ],
    ["{r: DBRef('users', 3)}", { r: { $ref: 'users', $id: 3 } }],
    ["{r: DBRef('users', 3, 'shop')}", { r: { $ref: 'users', $id: 3, $db: 'shop' } }],
    [
      '{n: 0x1F, d: Double(2), e: Double("1.5"), l: Long("-3")}',
      { n: 31, d: { $numberDouble: '2.0' }, e: { $numberDouble: '1.5' }, l: { $numberLong: '-3' } },
    ],
    [
      '{d: Decimal128("1e3"), x: -Infinity, y: +2}',
      { d: { $numberDecimal: '1e3' }, x: { $numberDouble: '-Infinity' }, y: 2 },
    ],
    [
      "{t: Timestamp(), o: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'), k: 'a\\x41'}",
      { t: { $timestamp: { t: 0, i: 0 } }, o: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, k: 'aA' },
    ],
  ];
  it.each(cases)('reads %s', (source, expected) => {
    expect(shellToExtendedJson(source)).toEqual(expected);
  });

  it('says what is wrong and where, without running anything', () => {
    const error = (source: string) => {
      try {
        shellToExtendedJson(source);
      } catch (thrown) {
        return thrown as QuerySyntaxError;
      }
      throw new Error('no error');
    };
    expect(error('{a: 1').reason).toBe('The text ends too soon');
    expect(error("{a: 'x}").reason).toBe('Unclosed string');
    const unknown = error('{a: 1,\n  b: this.c}');
    expect([unknown.reason, unknown.detail, unknown.line, unknown.column]).toEqual([
      'Unknown name',
      'this.c',
      2,
      6,
    ]);
    expect(error('{a: eval("1")}').reason).toBe('Unknown function');
    expect(error('{a: function() {}}').reason).toBe('Unknown function');
    expect(error('{a: ObjectId("123")}').reason).toBe('An ObjectId has 24 hexadecimal digits');
    expect(error('{a: NumberInt(3000000000)}').reason).toBe('The number does not fit in 32 bits');
    expect(error('{a: /x/g}').reason).toBe('Unknown regular expression option');
    expect(error('{a: 1} {b: 2}').reason).toBe('Unexpected character');
    expect(error('{a: ISODate("not a date")}').reason).toBe('Invalid date');
    expect(error('{a: BinData(0, "***")}').reason).toBe('Invalid base64');
    expect(error('{a: 1 /* open').reason).toBe('Unclosed comment');
    expect(error('{a: Decimal128("x")}').reason).toBe('Invalid decimal number');
    expect(error('{a: HexData(0, "abc")}').reason).toBe('Invalid hexadecimal data');
    expect(error('{a: UUID("12")}').reason).toBe('A UUID has 32 hexadecimal digits');
    expect(error('{a: NumberLong("99999999999999999999")}').reason).toBe(
      'The number does not fit in 64 bits',
    );
    expect(error('{a: NumberInt("x")}').reason).toBe('This function needs an integer');
    expect(error('{a: BinData(300, "AA==")}').reason).toBe('A binary subtype is between 0 and 255');
    expect(error('{a: RegExp("x", "g")}').reason).toBe('Unknown regular expression option');
    expect(error('{a: Double("x")}').reason).toBe('Invalid number');
    expect(error('{a: "\\u12"}').reason).toBe('Invalid escape in a string');
    expect(error('{a: /abc').reason).toBe('Unclosed regular expression');
    expect(error('{a: [1 2]}').reason).toBe('Unexpected character');
    expect(error('{a: @}').reason).toBe('Unexpected character');
    expect(error('{a: ').reason).toBe('The text ends too soon');
    expect(error('{1a: 2, "b" 3}').detail).toBe('expected :');
    const objectId = shellToExtendedJson('{a: new ObjectId()}') as { a: { $oid: string } };
    expect(objectId.a.$oid).toMatch(/^[0-9a-f]{24}$/);
    const now = shellToExtendedJson('{a: new Date()}') as { a: { $date: { $numberLong: string } } };
    expect(Number(now.a.$date.$numberLong)).toBeGreaterThan(1.7e12);
  });

  it('builds the query from the bar, with variables and counts', () => {
    const query = buildQuery(
      {
        ...emptyQueryForm(),
        filter: "{user: '{{userId}}', n: {{min}}}",
        projection: '{name: 1}',
        sort: '{at: -1, _id: 1}',
        collation: "{locale: 'es'}",
        hint: "'at_1'",
        skip: '20',
        limit: '0',
      },
      (text) => text.replace('{{userId}}', 'u-7').replace('{{min}}', '3'),
    );
    expect(query).toEqual({
      filter: { user: 'u-7', n: 3 },
      projection: { name: 1 },
      sort: { at: -1, _id: 1 },
      collation: { locale: 'es' },
      hint: 'at_1',
      skip: 20,
    });
    expect(Object.keys(query.sort ?? {})).toEqual(['at', '_id']);
    expect(buildQuery({ ...emptyQueryForm(), hint: '{at: 1}' }).hint).toEqual({ at: 1 });
    expect(buildQuery(emptyQueryForm())).toEqual({});

    const failure = (form: Partial<ReturnType<typeof emptyQueryForm>>) => {
      try {
        buildQuery({ ...emptyQueryForm(), ...form });
      } catch (thrown) {
        const error = thrown as QueryFieldError;
        return [error.field, error.key, error.params];
      }
      throw new Error('no error');
    };
    expect(failure({ filter: '{user: {{userId}}}' })).toEqual([
      'filter',
      'mongo.undefinedVariable',
      { v0: 'userId' },
    ]);
    expect(failure({ sort: '[1]' })).toEqual(['sort', 'mongo.notDocument', {}]);
    expect(failure({ skip: '-1' })).toEqual(['skip', 'mongo.notCount', {}]);
    expect(failure({ projection: '{a: }' })).toEqual([
      'projection',
      'mongo.syntax',
      { v0: 'Unexpected character', v1: 1, v2: 5, v3: '}' },
    ]);
  });

  it('reads stored queries defensively and names them', () => {
    expect(
      queryValue({ database: 'shop', collection: 'orders', filter: 3, folder: 'Reports' }),
    ).toEqual({
      ...emptyQueryForm(),
      connection: '',
      database: 'shop',
      collection: 'orders',
      folder: 'Reports',
    });
    expect(queryValue(null).database).toBe('');
    expect(
      querySummary({ database: 'shop', collection: 'orders', filter: "{ status:\n 'A' }" }),
    ).toBe("shop.orders { status: 'A' }");
    expect(querySummary({ database: 'd', collection: 'c', filter: 'x'.repeat(300) })).toHaveLength(
      200,
    );
  });
});
