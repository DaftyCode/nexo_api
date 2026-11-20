import { MongoUseCases } from './mongo-use-cases';
import type { ExportSource } from './mongo-use-cases';
import { WorkspaceDocument } from '../domain/models';
import { collectionApi, targetFile } from '../testing/mongo-transfer';
import { unzip } from '../testing/unzip';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://db.test' },
};
const source: ExportSource = {
  workspace: 'local',
  connection,
  scopes: { environment: [], collection: [], globals: [] },
  target: { database: 'shop', collection: 'customers' },
  query: {},
};
const customers = [
  {
    _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
    email: 'ana@corp.com',
    visits: { $numberInt: '7' },
    total: { $numberDouble: '12.5' },
    big: { $numberLong: '9007199254740993' },
    small: { $numberLong: '42' },
    vip: true,
    address: { city: 'Lugo' },
  },
];
const run = (format: 'jsonl' | 'xlsx', mask?: string) => {
  const from = collectionApi(customers);
  const file = targetFile();
  const fields = ['_id', 'email', 'visits', 'total', 'big', 'small', 'vip', 'address.city', 'none'];
  const done = new MongoUseCases(from.api, () => 'id').transfer.export(
    source,
    { format, flavour: 'relaxed', fields, ...(mask ? { mask } : {}) },
    file,
    () => undefined,
    new AbortController().signal,
  );
  return { done, file, store: from.store };
};

describe('MongoUseCases exports to Excel and with masking', () => {
  it('masks every page with the set chosen before writing it', async () => {
    const { done, file, store } = run('jsonl', 'm1');
    expect((await done).documents).toBe(1);
    expect(file.text).toContain('"email":"****"');
    expect(file.text).not.toContain('ana@corp.com');
    expect(store.masked).toEqual([{ workspace: 'local', set: 'm1', documents: customers }]);
  });

  it('writes the fields chosen as the columns of a workbook, numbers as numbers', async () => {
    const { done, file, store } = run('xlsx');
    await done;
    expect(store.masked).toEqual([]);
    expect(file.state).toBe('closed');
    const files = unzip(file.bytes[0]);
    expect(files.get('xl/workbook.xml')).toContain('name="customers"');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<t xml:space="preserve">address.city</t>');
    expect(sheet).toContain('<t xml:space="preserve">65a1b2c3d4e5f6a7b8c9d0e1</t>');
    expect(sheet).toContain('<c r="C2"><v>7</v></c>');
    expect(sheet).toContain('<c r="D2"><v>12.5</v></c>');
    // A long integer that a number cannot hold exactly stays text.
    expect(sheet).toContain('<t xml:space="preserve">9007199254740993</t>');
    expect(sheet).toContain('<c r="F2"><v>42</v></c>');
    expect(sheet).toContain('<c r="G2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">Lugo</t>');
    expect(sheet).not.toContain('r="I2"');
  });
});
