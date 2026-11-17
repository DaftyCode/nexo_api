import { describe, expect, it } from 'vitest';
import { ResultColumn } from '../results';
import { BOM, defaultExportOptions, exportFormatOf, exportWriter } from './export';
import { cellValue, inferKind, kindColumn, kindOfColumn, previewRows } from './import';

const columns: ResultColumn[] = [
  { name: 'id', typeName: 'int4', kind: 'integer' },
  { name: 'data', typeName: 'bytea', kind: 'binary' },
];
const style = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const writer = (format: Parameters<typeof exportWriter>[0], options = {}) =>
  exportWriter(format, { columns, table: '"t"', style }, { ...defaultExportOptions(), ...options });

describe('exporting, at its edges', () => {
  it('reads the format of @export from a name or DBeaver JSON', () => {
    expect(exportFormatOf('')).toBe('csv');
    expect(exportFormatOf('JSONL')).toBe('jsonl');
    expect(exportFormatOf('{"format": "xml"}')).toBe('xml');
    expect(exportFormatOf('{"type": "markdown"}')).toBe('markdown');
    expect(exportFormatOf('{}')).toBe('csv');
    expect(exportFormatOf('{bad')).toBeUndefined();
    expect(exportFormatOf('pdf')).toBeUndefined();
  });

  it('writes binaries as NULL or hexadecimal, and no header when not asked', () => {
    const bytes = { $t: 'binary', v: 'AQI=' };
    const csv = writer('csv', { binary: 'null', header: false, nullText: 'NULL' });
    expect(csv.start() + csv.page([[1, bytes]])).toBe('1,NULL\n');
    const hex = writer('csv', { binary: 'hex', header: false });
    expect(
      hex.page([
        [1, bytes],
        [2, { $t: 'binary' }],
      ]),
    ).toBe('1,0102\n2,\n');
  });

  it('closes an empty JSON array, and writes a BOM first when asked', () => {
    const json = writer('json', { bom: true });
    expect(json.start() + json.end()).toBe(`${BOM}[]\n`);
  });

  it('writes one row per INSERT when the number asked is not one', () => {
    const sql = writer('sql', { rowsPerInsert: Number.NaN });
    expect(
      sql.page([
        [1, null],
        [2, null],
      ]),
    ).toBe(
      'INSERT INTO "t" (id, data) VALUES (1, NULL);\nINSERT INTO "t" (id, data) VALUES (2, NULL);\n',
    );
  });

  it('writes only the names as text when there is no row', () => {
    const text = writer('text');
    expect(text.start() + text.end()).toBe('id | data\n');
    const short = writer('text');
    expect(short.page([[1]])).toContain('id | data');
  });
});

describe('importing, at its edges', () => {
  it('guesses kinds from numbers, booleans and floats', () => {
    expect(inferKind([1, 2])).toBe('integer');
    expect(inferKind([1.5])).toBe('decimal');
    expect(inferKind([true])).toBe('boolean');
    expect(inferKind(['1e5', '2.5E-3'])).toBe('float');
    expect(inferKind(['1.5', '2'])).toBe('decimal');
    expect(inferKind(['2026-01-02T10:00', '2026-01-03'])).toBe('timestamp');
    expect(inferKind([null, ''])).toBe('text');
  });

  it('sends each kind as its value, or as its text when it does not fit', () => {
    const none = { trim: false, emptyAsNull: false };
    expect(cellValue(undefined, 'text', none)).toBeNull();
    expect(cellValue('1.5e3', 'float', none)).toBe(1500);
    expect(cellValue('', 'float', none)).toBe('');
    expect(cellValue('many', 'float', none)).toBe('many');
    expect(cellValue('yes', 'boolean', none)).toBe(true);
    expect(cellValue('no', 'boolean', none)).toBe(false);
    expect(cellValue('maybe', 'boolean', none)).toBe('maybe');
    expect(cellValue(12.5, 'decimal', none)).toBe(12.5);
    expect(cellValue(true, 'text', none)).toBe(true);
    expect(cellValue('2026-01-02', 'date', none)).toBe('2026-01-02');
  });

  it('names a created column by its target, else by its name', () => {
    expect(kindColumn({ name: 'Price', target: '', kind: 'float' })).toEqual({
      name: 'Price',
      kind: 'float',
      typeName: 'double',
    });
    expect(kindColumn({ name: 'Price', target: 'price', kind: 'date' }).name).toBe('price');
  });

  it('previews a file with a BOM, JSON documents and CSV without a header', () => {
    expect(previewRows(`${BOM}a,b\n1,2\n`, 'csv', ',', true)).toEqual({
      names: ['a', 'b'],
      rows: [['1', '2']],
    });
    expect(previewRows('1;2\n', 'csv', ';', false)).toEqual({
      names: ['column1', 'column2'],
      rows: [['1', '2']],
    });
    expect(previewRows('', 'csv', ',', false)).toEqual({ names: [], rows: [] });
    expect(previewRows('', 'csv', ',', true)).toEqual({ names: [], rows: [] });
    expect(previewRows('{"a":1}\n{"b":2}\n', 'json', ',', true)).toEqual({
      names: ['a', 'b'],
      rows: [
        [1, null],
        [null, 2],
      ],
    });
  });

  it('takes the kind of a table column from its driver', () => {
    expect(kindOfColumn('timestamptz')).toBe('timestamp');
    expect(kindOfColumn('timestamp')).toBe('timestamp');
    expect(kindOfColumn('text')).toBe('text');
    expect(kindOfColumn('binary')).toBeUndefined();
  });
});
