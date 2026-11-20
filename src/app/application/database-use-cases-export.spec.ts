import { describe, expect, it } from 'vitest';
import { defaultExportOptions } from '../domain/db/transfer/export';
import { databaseCases as fixture, never, targetFile as target } from '../testing/database-cases';
import { unzip } from '../testing/unzip';

const job = (format: 'csv' | 'xlsx', mask?: string) => ({
  workspace: 'w',
  session: 's',
  sql: 'SELECT * FROM t',
  format,
  options: { ...defaultExportOptions(), header: true },
  shape: {
    table: '"shop"."orders"',
    style: { name: 'postgresql', quoteOpen: '"', quoteClose: '"' },
  },
  ...(mask ? { mask } : {}),
});
const columns = [
  { name: 'id', typeName: 'int', kind: 'integer' },
  { name: 'card', typeName: 'text', kind: 'text' },
  { name: 'pin', typeName: 'text', kind: 'text' },
];
/** The engine masks the card and removes the pin. */
const maskApply = (payload: Record<string, unknown>) => ({
  kept: [0, 1],
  rows: (payload['rows'] as unknown[][]).map((row) => [row[0], '**** 1234']),
});

describe('exports of database rows', () => {
  it('masks every page with the set chosen, leaving out the columns removed', async () => {
    const { cases, named } = fixture({
      'db.execute': { columns, rows: [[1, '4111111111111234', '0000']], cursor: 'c1' },
      'db.fetch': { rows: [[2, '5500000000001234', '1111']], cursor: null },
      'mask.apply': maskApply,
    });
    const file = target();
    const done = await cases.transfer.exportRows(job('csv', 'm1'), file, () => undefined, never);
    expect(done).toEqual({ rows: 2, cancelled: false });
    expect(file.text).toBe('id,card\n1,**** 1234\n2,**** 1234\n');
    expect(named('mask.apply')).toEqual([
      {
        workspace: 'w',
        set: 'm1',
        columns: ['id', 'card', 'pin'],
        rows: [[1, '4111111111111234', '0000']],
      },
      {
        workspace: 'w',
        set: 'm1',
        columns: ['id', 'card', 'pin'],
        rows: [[2, '5500000000001234', '1111']],
      },
    ]);
  });

  it('writes an Excel workbook at the end, named after the table', async () => {
    const { cases, named } = fixture({
      'db.execute': { columns, rows: [[1, 'a', 'b']], cursor: 'c1' },
      'db.fetch': { rows: [[2, 'c', 'd']], cursor: null },
      'mask.apply': maskApply,
    });
    const plain = target();
    await cases.transfer.exportRows(job('xlsx'), plain, () => undefined, never);
    expect(plain.text).toBe('');
    expect(plain.bytes).toHaveLength(1);
    const files = unzip(plain.bytes[0]);
    expect(files.get('xl/workbook.xml')).toContain('name="shop.orders"');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="C1" s="1" t="inlineStr"><is><t xml:space="preserve">pin');
    expect(sheet).toContain('<c r="A3"><v>2</v></c>');
    expect(named('mask.apply')).toEqual([]);

    const masked = target();
    await cases.transfer.exportRows(job('xlsx', 'm1'), masked, () => undefined, never);
    const maskedSheet = unzip(masked.bytes[0]).get('xl/worksheets/sheet1.xml')!;
    expect(maskedSheet).not.toContain('pin');
    expect(maskedSheet).toContain('**** 1234');
  });

  it('drops the workbook of a cancelled export', async () => {
    const { cases } = fixture({ 'db.execute': { columns, rows: [[1, 'a', 'b']], cursor: 'c1' } });
    const controller = new AbortController();
    controller.abort();
    const file = target();
    await cases.transfer.exportRows(job('xlsx'), file, () => undefined, controller.signal);
    expect(file.discarded).toBe(true);
    expect(file.bytes).toEqual([]);
  });
});
