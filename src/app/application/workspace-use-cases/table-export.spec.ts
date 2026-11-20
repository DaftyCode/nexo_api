import { RunReport } from '../../domain/reports';
import { XLSX_TYPE } from '../../domain/export/xlsx';
import { unzip } from '../../testing/unzip';
import { MaskingCases } from './masking';
import { TableExportCases, fileName } from './table-export';

function cases() {
  const masked: { set: string; documents: readonly unknown[] }[] = [];
  const masking = {
    documents: async (_workspace: string, set: string, documents: readonly unknown[]) => {
      masked.push({ set, documents });
      return documents.map((document) =>
        JSON.parse(JSON.stringify(document).replaceAll('ana@corp.com', '****')),
      );
    },
  } as unknown as MaskingCases;
  return { tables: new TableExportCases(masking), masked };
}

const report: RunReport = {
  collection: 'Shop: orders/v2',
  state: 'completed',
  duration: 5,
  totals: { requests: 1, failedRequests: 0, passed: 1, failed: 0, skipped: 0 },
  requests: [
    {
      name: 'List',
      method: 'GET',
      url: 'https://api.test',
      iteration: 0,
      status: 200,
      statusText: 'OK',
      time: 5,
      failed: false,
      assertions: [{ name: 'ok', passed: true, skipped: false }],
    },
  ],
  other: [],
};

describe('TableExportCases', () => {
  it('names files as every system accepts them', () => {
    expect(fileName('Shop: orders/v2', 'x')).toBe('Shop- orders-v2');
    expect(fileName('  ', 'fallback')).toBe('fallback');
    expect(fileName('a\u0001b', 'x')).toBe('a-b');
  });

  it('exports a run as CSV, one row per request and iteration', async () => {
    const { tables, masked } = cases();
    const file = await tables.run('local', report, { format: 'csv', separator: ';', set: '' });
    expect(file).toMatchObject({
      name: 'Shop- orders-v2.csv',
      type: 'text/csv;charset=utf-8',
      rows: 1,
      cut: false,
    });
    const lines = String(file.data).split('\r\n');
    expect(lines[0]).toBe(
      '﻿iteration;request;method;url;status;statusText;timeMs;result;passed;failed;skipped;failures;error',
    );
    expect(lines[1]).toBe('1;List;GET;https://api.test;200;OK;5;passed;1;0;0;;');
    expect(masked).toEqual([]);
  });

  it('masks records before they become columns, and writes a workbook', async () => {
    const { tables, masked } = cases();
    const records = [{ id: 1, customer: { email: 'ana@corp.com' }, email: 'ana@corp.com' }];
    const file = await tables.records('local', records, 'customers', {
      format: 'xlsx',
      separator: ',',
      set: 'm1',
    });
    expect(masked).toEqual([{ set: 'm1', documents: records }]);
    expect(file).toMatchObject({ name: 'customers.xlsx', type: XLSX_TYPE, rows: 1, cut: false });
    const sheet = unzip(file.data as Uint8Array).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('customer.email');
    expect(sheet).not.toContain('<t xml:space="preserve">ana@corp.com');
    expect(sheet).toContain('<t xml:space="preserve">****</t>');
  });

  it('says when a table had more columns than it keeps', async () => {
    const { tables } = cases();
    const wide = Object.fromEntries(Array.from({ length: 1001 }, (_, at) => [`c${at}`, at]));
    const file = await tables.records('local', [wide], 'wide', {
      format: 'csv',
      separator: ',',
      set: '',
    });
    expect(file.cut).toBe(true);
  });
});
