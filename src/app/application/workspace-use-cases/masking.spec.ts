import { WorkspaceDocument } from '../../domain/models';
import { emptyMaskingForm } from '../../domain/masking';
import { MASK_BATCH, MaskingCases } from './masking';

function fakeApi() {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  const api = {
    execute: async (operation: string, payload: Record<string, unknown>) => {
      calls.push({ operation, payload });
      if (payload['rows'])
        return {
          kept: [0, 2],
          rows: (payload['rows'] as unknown[][]).map((row) => [row[0], '****']),
        };
      return {
        documents: (payload['documents'] as unknown[]).map((document) => ({ masked: document })),
      };
    },
    save: async (document: WorkspaceDocument) => ({ ...document, revision: document.revision + 1 }),
    remove: async (document: WorkspaceDocument) =>
      void calls.push({ operation: 'remove', payload: { id: document.id } }),
  };
  return { cases: new MaskingCases(api as never), calls };
}

const document = (id: string, name: string, kind = 'masking'): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind,
  name,
  revision: 2,
  updated_at: 5,
  value: { rules: [{ path: 'email', method: 'hash' }] },
});

describe('MaskingCases', () => {
  it('lists the sets among the documents, by name', () => {
    const { cases } = fakeApi();
    const sets = cases.sets([
      document('b', 'Zeta'),
      document('c', 'Collection', 'collection'),
      document('a', 'Alpha'),
    ]);
    expect(sets.map((set) => set.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('saves a set with its revision, and deletes it', async () => {
    const { cases, calls } = fakeApi();
    const form = {
      ...emptyMaskingForm(),
      name: ' PII ',
      agents: true,
      rules: [{ path: 'email', method: 'hide' as const, keep: 4 }],
    };
    const created = await cases.save('local', 'm1', form);
    expect(created).toMatchObject({
      id: 'm1',
      kind: 'masking',
      name: 'PII',
      revision: 1,
      value: { agents: true, rules: [{ path: 'email', method: 'hide' }] },
    });
    const updated = await cases.save('local', 'm1', form, document('m1', 'PII'));
    expect(updated.revision).toBe(3);
    await cases.remove(updated);
    expect(calls.at(-1)).toEqual({ operation: 'remove', payload: { id: 'm1' } });
  });

  it('tries rules not saved yet on an example', async () => {
    const { cases, calls } = fakeApi();
    const rules = [{ path: 'email', method: 'truncate' as const, keep: 2 }];
    expect(await cases.tryRules('local', rules, '[{"a":1}]')).toEqual([{ masked: { a: 1 } }]);
    expect(await cases.tryRules('local', rules, '{"a":1}')).toEqual({ masked: { a: 1 } });
    expect(calls[0].payload).toEqual({
      workspace: 'local',
      rules: [{ path: 'email', method: 'truncate', keep: 2 }],
      documents: [{ a: 1 }],
    });
    await expect(cases.tryRules('local', rules, '{')).rejects.toThrow(
      'The example must be valid JSON',
    );
  });

  it('masks documents with a saved set, in batches', async () => {
    const { cases, calls } = fakeApi();
    const documents = Array.from({ length: MASK_BATCH + 1 }, (_, id) => ({ id }));
    const masked = await cases.documents('local', 'm1', documents);
    expect(masked.length).toBe(MASK_BATCH + 1);
    expect(masked[MASK_BATCH]).toEqual({ masked: { id: MASK_BATCH } });
    expect(calls.map((call) => (call.payload['documents'] as unknown[]).length)).toEqual([
      MASK_BATCH,
      1,
    ]);
    expect(calls[0].payload['set']).toBe('m1');
    expect(await cases.documents('local', 'm1', [])).toEqual([]);
  });

  it('masks rows and leaves out the columns a rule removes', async () => {
    const { cases, calls } = fakeApi();
    const masked = await cases.rows('local', 'm1', ['id', 'secret', 'email'], [[1, 'x', 'a@b.c']]);
    expect(masked).toEqual({ columns: ['id', 'email'], rows: [[1, '****']], kept: [0, 2] });
    expect(calls[0].payload).toEqual({
      workspace: 'local',
      set: 'm1',
      columns: ['id', 'secret', 'email'],
      rows: [[1, 'x', 'a@b.c']],
    });
    // Without rows the columns still say which ones stay.
    expect((await cases.rows('local', 'm1', ['id', 'secret', 'email'], [])).columns).toEqual([
      'id',
      'email',
    ]);
  });
});
