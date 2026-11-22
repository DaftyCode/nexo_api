import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../../domain/models';
import { DatabaseConnectionImportCases } from './connection-import';

describe('DatabaseConnectionImportCases', () => {
  it('saves what a file brings, profiles first, and tells what the backend refused', async () => {
    const saved: WorkspaceDocument[] = [];
    let next = 0;
    const cases = new DatabaseConnectionImportCases(
      {
        async save(document) {
          if (document.name === 'bad') throw new Error('Unknown database driver');
          if (document.name === 'odd') throw 'refused';
          saved.push(document);
          return { ...document, revision: 1 };
        },
      },
      () => `n${++next}`,
    );
    const read = cases.read(
      ['postgresql://ana@db/shop', 'mysql://bad@db/x', 'mysql://odd@db/y'].join('\n'),
    );
    read.documents[1].name = 'bad';
    read.documents[2].name = 'odd';
    const outcome = await cases.save('local', read);
    expect(saved).toEqual([
      expect.objectContaining({ id: 'n1', workspace_id: 'local', kind: 'connection', revision: 0 }),
    ]);
    expect(outcome.saved[0].revision).toBe(1);
    expect(outcome.refused).toEqual([
      { name: 'bad', error: 'Unknown database driver' },
      { name: 'odd', error: 'refused' },
    ]);
    expect(JSON.parse(cases.export(outcome.saved, ['n1'])).connections).toHaveLength(1);
  });
});
