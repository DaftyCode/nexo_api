import { ResultColumn } from '../results';
import { defaultExportOptions, exportWriter, ExportFormat } from './export';
import { cellValue, inferKind, kindColumn, matchColumns, objectRows, rowValues } from './import';

const columns: ResultColumn[] = [
  { name: 'id', typeName: 'int4', kind: 'integer' },
  { name: 'label', typeName: 'text', kind: 'text' },
  { name: 'data', typeName: 'bytea', kind: 'binary' },
];
const rows = [
  [1, 'lamp, "LED"', { $t: 'binary', v: 'AQI=' }],
  [2, null, null],
];
const style = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };

function whole(format: ExportFormat, options = defaultExportOptions(), ddl?: string) {
  const writer = exportWriter(format, { columns, table: '"items"', style, ddl }, options);
  return writer.start() + writer.page(rows.slice(0, 1)) + writer.page(rows.slice(1)) + writer.end();
}

describe('exporting rows', () => {
  it.each([
    ['csv', 'id,label,data\n1,"lamp, ""LED""",AQI=\n2,,\n'],
    [
      'jsonl',
      '{"id":1,"label":"lamp, \\"LED\\"","data":"AQI="}\n{"id":2,"label":null,"data":null}\n',
    ],
    [
      'json',
      '[\n  {"id":1,"label":"lamp, \\"LED\\"","data":"AQI="},\n  {"id":2,"label":null,"data":null}\n]\n',
    ],
    [
      'sql',
      `INSERT INTO "items" (id, label, data) VALUES (1, 'lamp, "LED"', '\\x0102');\nINSERT INTO "items" (id, label, data) VALUES (2, NULL, NULL);\n`,
    ],
    [
      'markdown',
      '| id | label | data |\n| --- | --- | --- |\n| 1 | lamp, "LED" | AQI= |\n| 2 |  |  |\n',
    ],
  ])('writes %s across pages', (format, expected) => {
    expect(whole(format as ExportFormat)).toBe(expected);
  });

  it('writes markup escaped, aligned text, many rows per INSERT and binary as hex', () => {
    expect(whole('html')).toContain('<td>lamp, &quot;LED&quot;</td>');
    expect(whole('xml')).toContain('<column name="label" null="true"/>');
    expect(whole('text').split('\n').slice(0, 3)).toEqual([
      'id | label       | data',
      '---+-------------+-----',
      '1  | lamp, "LED" | AQI=',
    ]);
    const options = { ...defaultExportOptions(), rowsPerInsert: 100, binary: 'hex' as const };
    const sql = whole('sql', options, 'CREATE TABLE "items" ("id" int);');
    expect(sql.startsWith('CREATE TABLE "items" ("id" int);\n\nINSERT INTO')).toBe(true);
    expect(whole('csv', { ...options, separator: ';', bom: true })).toBe(
      '\ufeffid;label;data\n1;"lamp, ""LED""";0102\n2;;\n',
    );
  });
});

describe('importing a file', () => {
  it('guesses kinds from samples and matches columns by name', () => {
    expect(inferKind(['1', '22', ''])).toBe('integer');
    expect(inferKind(['1', '2.5'])).toBe('decimal');
    expect(inferKind(['2026-01-02', '2026-01-02 10:00:00'])).toBe('timestamp');
    expect(inferKind(['true', 'FALSE'])).toBe('boolean');
    expect(inferKind(['1', 'x'])).toBe('text');
    expect(inferKind([{ a: 1 }])).toBe('json');
    const matched = matchColumns(
      ['ID', 'Full Name', 'extra'],
      [['1', 'Ana', 'x']],
      ['id', 'full_name'],
    );
    expect(matched.map((column) => [column.target, column.kind])).toEqual([
      ['id', 'integer'],
      ['full_name', 'text'],
      ['', 'text'],
    ]);
    expect(kindColumn(matched[0])).toEqual({ name: 'id', kind: 'integer', typeName: 'bigint' });
  });

  it('turns cells into the values sent, and skips the columns that go nowhere', () => {
    const transform = { trim: true, emptyAsNull: true };
    expect(cellValue(' 12 ', 'integer', transform)).toBe(12);
    expect(cellValue('99999999999999999999', 'integer', transform)).toBe('99999999999999999999');
    expect(cellValue('1.10', 'decimal', transform)).toBe('1.10');
    expect(cellValue('', 'text', transform)).toBeNull();
    expect(cellValue('', 'text', { trim: false, emptyAsNull: false })).toBe('');
    expect(cellValue('yes', 'boolean', transform)).toBe(true);
    expect(cellValue({ a: 1 }, 'json', transform)).toBe('{"a":1}');
    const columns = [
      { name: 'a', target: 'a', kind: 'integer' as const },
      { name: 'b', target: '', kind: 'text' as const },
      { name: 'c', target: 'c', kind: 'text' as const },
    ];
    expect(rowValues(['1', 'skip', 'x'], columns, transform)).toEqual([1, 'x']);
    const keys: string[] = [];
    expect(objectRows([{ a: 1 }, { b: 2, a: 3 }], keys)).toEqual([
      [1, null],
      [3, 2],
    ]);
    expect(keys).toEqual(['a', 'b']);
  });
});

describe('@export', () => {
  it('names a format by its name or as DBeaver writes it', async () => {
    const { exportFormatOf } = await import('./export');
    expect(exportFormatOf('jsonl')).toBe('jsonl');
    expect(exportFormatOf('')).toBe('csv');
    expect(exportFormatOf('{"type": "JSON"}')).toBe('json');
    expect(exportFormatOf('{"format": "sql"}')).toBe('sql');
    expect(exportFormatOf('xlsx')).toBeUndefined();
    expect(exportFormatOf('{broken')).toBeUndefined();
  });
});
