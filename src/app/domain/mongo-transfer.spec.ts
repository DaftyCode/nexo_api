import {
  CsvReader,
  JsonDocumentsReader,
  ReadDocument,
  cellText,
  csvRecord,
  documentFields,
  exportName,
  formatOf,
  jsonDocument,
  rowDocument,
  transferValue,
  typedValue,
} from './mongo-transfer';
import { emptyQueryForm } from './mongo-query';

/** Reads `text` in chunks of `size` characters, as a file arrives. */
function inChunks<T>(reader: { push(text: string): T[]; end(): T[] }, text: string, size: number) {
  const read: T[] = [];
  for (let start = 0; start < text.length; start += size)
    read.push(...reader.push(text.slice(start, start + size)));
  return [...read, ...reader.end()];
}

describe('CSV cells', () => {
  it('write numbers, ids and dates plainly and the rest as JSON', () => {
    const cases: [unknown, string][] = [
      [undefined, ''],
      [null, ''],
      ['plain, "quoted"', 'plain, "quoted"'],
      [true, 'true'],
      [{ $numberInt: '7' }, '7'],
      [{ $numberLong: '9007199254740993' }, '9007199254740993'],
      [{ $numberDouble: '1.5' }, '1.5'],
      [{ $numberDecimal: '19.99' }, '19.99'],
      [{ $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, '65a1b2c3d4e5f6a7b8c9d0e1'],
      [{ $date: { $numberLong: '0' } }, '1970-01-01T00:00:00.000Z'],
      [[{ $numberInt: '1' }, 'a'], '[1,"a"]'],
    ];
    for (const [value, text] of cases) expect(cellText(value), JSON.stringify(value)).toBe(text);
  });

  it('read back with the type chosen, or say why they cannot', () => {
    const cases: [string, Parameters<typeof typedValue>[1], ReturnType<typeof typedValue>][] = [
      ['', 'auto', {}],
      ['', 'string', { value: '' }],
      ['x', 'skip', {}],
      ['42', 'auto', { value: { $numberInt: '42' } }],
      ['3000000000', 'auto', { value: { $numberLong: '3000000000' } }],
      ['2.5', 'auto', { value: { $numberDouble: '2.5' } }],
      ['true', 'auto', { value: true }],
      ['007', 'string', { value: '007' }],
      ['42', 'long', { value: { $numberLong: '42' } }],
      ['4.2', 'int', { error: 'number' }],
      ['99999999999999999999', 'long', { error: 'number' }],
      ['1e3', 'double', { value: { $numberDouble: '1000' } }],
      ['19.990', 'decimal', { value: { $numberDecimal: '19.990' } }],
      ['yes', 'bool', { value: true }],
      ['maybe', 'bool', { error: 'bool' }],
      ['1970-01-02T00:00:00Z', 'date', { value: { $date: { $numberLong: '86400000' } } }],
      ['86400000', 'date', { value: { $date: { $numberLong: '86400000' } } }],
      ['not a date', 'date', { error: 'date' }],
      ['65A1B2C3D4E5F6A7B8C9D0E1', 'objectId', { value: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' } }],
      ['65a1', 'objectId', { error: 'objectId' }],
      ['{"a":[1]}', 'json', { value: { a: [1] } }],
      ['{a', 'json', { error: 'json' }],
    ];
    for (const [text, type, expected] of cases)
      expect(typedValue(text, type), `${text} as ${type}`).toEqual(expected);
  });
});

describe('CSV files', () => {
  it('flatten embedded documents with dots and quote what needs it', () => {
    const documents = [
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, name: 'Ana, "A"', address: { city: 'Lugo' } },
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e2' }, tags: ['x'], address: { zip: '27001' } },
    ];
    const fields = documentFields(documents);
    expect(fields).toEqual(['_id', 'name', 'address.city', 'tags', 'address.zip']);
    expect(csvRecord(documents[0], fields)).toBe('65a1b2c3d4e5f6a7b8c9d0e1,"Ana, ""A""",Lugo,,');
    expect(csvRecord(documents[1], fields)).toBe('65a1b2c3d4e5f6a7b8c9d0e2,,,"[""x""]",27001');
  });

  it('are read in any chunks, with quoted separators, quotes and line breaks', () => {
    const text = 'name,note\r\n"Ana, A","said ""hi""\nthen left"\r\nLuis,\n\n"",last';
    const expected = [
      ['name', 'note'],
      ['Ana, A', 'said "hi"\nthen left'],
      ['Luis', ''],
      ['', 'last'],
    ];
    for (const size of [1, 2, 3, 7, text.length])
      expect(inChunks(new CsvReader(), text, size), `chunks of ${size}`).toEqual(expected);
  });

  it('build documents from columns, with embedded fields and errors by column', () => {
    const columns = [
      { column: 'id', field: '_id', type: 'objectId' as const },
      { column: 'city', field: 'address.city', type: 'string' as const },
      { column: 'zip', field: 'address.zip', type: 'string' as const },
      { column: 'age', field: 'age', type: 'int' as const },
      { column: 'notes', field: 'notes', type: 'skip' as const },
    ];
    expect(rowDocument(['65a1b2c3d4e5f6a7b8c9d0e1', 'Lugo', '27001', '41', 'x'], columns)).toEqual({
      document: {
        _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
        address: { city: 'Lugo', zip: '27001' },
        age: { $numberInt: '41' },
      },
      errors: [],
    });
    expect(rowDocument(['bad', 'Lugo', '', 'old'], columns).errors).toEqual([
      { column: 'id', type: 'objectId' },
      { column: 'age', type: 'number' },
    ]);
  });
});

describe('JSON files', () => {
  it('read arrays, JSON Lines and shell syntax in any chunks', () => {
    const cases: [string, ReadDocument[]][] = [
      ['[{"a":1},{"b":"}{"}]', [{ document: { a: 1 } }, { document: { b: '}{' } }]],
      ['{"a":1}\n{"a":2}\n', [{ document: { a: 1 } }, { document: { a: 2 } }]],
      [
        "[{_id: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'), n: NumberLong(5)}]",
        [{ document: { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, n: { $numberLong: '5' } } }],
      ],
      [
        '[{"a":1}, 7, {"b":2}]',
        [{ document: { a: 1 } }, { error: 'json' }, { document: { b: 2 } }],
      ],
      ['{"a":', [{ error: 'json' }]],
      [
        '{"a":1}\nnot json, at all\n{"a":2}',
        [{ document: { a: 1 } }, { error: 'json' }, { document: { a: 2 } }],
      ],
    ];
    for (const [text, expected] of cases)
      for (const size of [1, 4, text.length])
        expect(inChunks(new JsonDocumentsReader(), text, size), `${text} by ${size}`).toEqual(
          expected,
        );
  });

  it('write canonical Extended JSON or relaxed values', () => {
    const document = { n: { $numberInt: '1' }, d: { $numberDouble: '1.5' } };
    expect(jsonDocument(document, 'canonical')).toBe(JSON.stringify(document));
    expect(jsonDocument(document, 'relaxed')).toBe('{"n":1,"d":1.5}');
  });
});

describe('Transfers', () => {
  it('know the format of a file and name an export', () => {
    expect(formatOf('orders.csv')).toBe('csv');
    expect(formatOf('dump.ndjson')).toBe('jsonl');
    expect(formatOf('export', '[')).toBe('json');
    expect(exportName('my orders', 'jsonl', new Date('2026-11-12T10:00:00Z'))).toBe(
      'my_orders-2026-11-12.jsonl',
    );
  });

  it('read stored transfers with defaults for what is missing or unknown', () => {
    const stored = transferValue({
      direction: 'import',
      connection: 'c1',
      format: 'xml',
      mode: 'upsert',
      key: ['sku', 3],
      columns: [{ column: 'a', field: 'b', type: 'int' }, 'x'],
      continueOnError: false,
      query: { filter: '{a: 1}', skip: 3 },
      destination: 'collection',
      to: { connection: 'c2', collection: 'copy' },
    });
    expect(stored).toEqual(
      expect.objectContaining({
        direction: 'import',
        connection: 'c1',
        database: '',
        format: 'json',
        flavour: 'canonical',
        mode: 'upsert',
        key: ['sku'],
        columns: [{ column: 'a', field: 'b', type: 'int' }],
        continueOnError: false,
        query: { ...emptyQueryForm(), filter: '{a: 1}' },
        destination: 'collection',
        to: { connection: 'c2', database: '', collection: 'copy' },
      }),
    );
  });
});
