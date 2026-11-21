import { describe, expect, it } from 'vitest';
import { WorkspaceDocument } from '../domain/models';
import { databaseCases as fixture } from '../testing/database-cases';

describe('the search, assist and statement preferences', () => {
  it('searches by statement name, and remembers the last texts first', async () => {
    const { cases, named, preferences } = fixture({ 'db.search': { objects: [] } });
    await cases.search.search('w', 's', 'q1', { mode: 'metadata', text: 'ord' });
    expect(named('db.search')).toEqual([
      { workspace: 'w', session: 's', statement: 'q1', mode: 'metadata', text: 'ord' },
    ]);
    expect(cases.search.recent()).toEqual([]);
    cases.search.remember('a');
    cases.search.remember('b');
    cases.search.remember('a');
    expect(cases.search.recent()).toEqual(['a', 'b']);
    preferences.set('db.searches', '{bad');
    expect(cases.search.recent()).toEqual([]);
    preferences.set('db.searches', '{"a":1}');
    expect(cases.search.recent()).toEqual([]);
    preferences.set('db.searches', '["x", 1]');
    expect(cases.search.recent()).toEqual(['x']);
  });

  it('remembers parameter values, keeping only texts', () => {
    const { cases, preferences } = fixture();
    expect(cases.assist.parameters()).toEqual({});
    cases.assist.remember({ id: '1' });
    cases.assist.remember({ name: 'Ann' });
    expect(cases.assist.parameters()).toEqual({ id: '1', name: 'Ann' });
    preferences.set('db.parameters', '{"a": 1, "b": "2"}');
    expect(cases.assist.parameters()).toEqual({ b: '2' });
    preferences.set('db.parameters', 'null');
    expect(cases.assist.parameters()).toEqual({});
    preferences.set('db.parameters', '{bad');
    expect(cases.assist.parameters()).toEqual({});
  });

  it('keeps the failure choice, the transaction limits and the page of a fetch', async () => {
    const { cases, named, preferences } = fixture({
      'db.fetch': { rows: [] },
      'db.rows.write': {},
    });
    cases.statements.setOnFailure('stop');
    expect(cases.statements.onFailure()).toBe('stop');
    cases.statements.setOnFailure('ask');
    expect(preferences.get('db.scriptFailure')).toBe('');
    cases.statements.setTransactionLimits({ warnMinutes: 5, rollbackMinutes: 2000 });
    expect(cases.statements.transactionLimits()).toMatchObject({ warnMinutes: 5 });
    expect(cases.statements.transactionLimits().rollbackMinutes).not.toBe(2000);
    await cases.statements.fetch('w', 's', 'c', 50);
    await cases.statements.fetch('w', 's', 'c');
    expect(named('db.fetch')).toEqual([
      { workspace: 'w', session: 's', cursor: 'c', pageRows: 50 },
      { workspace: 'w', session: 's', cursor: 'c' },
    ]);
    await cases.statements.writeRows('w', 's', {
      schema: 'shop',
      table: 't',
      changes: [],
      optimistic: true,
      confirm: true,
    });
    await cases.statements.writeRows('w', 's', { table: 't', changes: [], optimistic: false });
    expect(named('db.rows.write')).toEqual([
      {
        workspace: 'w',
        session: 's',
        table: 't',
        changes: [],
        schema: 'shop',
        optimistic: true,
        confirm: true,
      },
      { workspace: 'w', session: 's', table: 't', changes: [] },
    ]);
    await cases.statements.closeCursor('w', 's', 'gone');
    await cases.statements.cancel('w', 's', 'q');
    expect(named('db.cancel')).toEqual([{ workspace: 'w', session: 's', statement: 'q' }]);
  });
});

describe('the connection use cases, at their edges', () => {
  const document = (id: string, value: unknown): WorkspaceDocument => ({
    id,
    workspace_id: 'w',
    kind: 'connection',
    name: id,
    revision: 2,
    updated_at: 0,
    value,
  });

  it('duplicates a connection with its vault references, and forgets secrets quietly', async () => {
    const { cases, saved, removedSecrets } = fixture();
    await cases.connections.duplicate(
      'w',
      document('a', { driver: 'x', password: '{{vault:db-password:a}}' }),
      'b',
      'Copy',
    );
    expect(saved[0]).toMatchObject({
      id: 'b',
      name: 'Copy',
      revision: 0,
      value: { password: '{{vault:db-password:a}}' },
    });
    await cases.connections.forget('z');
    expect(removedSecrets).toEqual(['db-password:z', 'db-key:z', 'db-proxy:z']);
  });

  it('drops the filters of a connection when none is left', async () => {
    const { cases, saved } = fixture();
    await cases.connections.setFilters(document('a', { driver: 'x', filters: [{ path: [] }] }), []);
    expect(saved[0].value).toEqual({ driver: 'x' });
    await cases.connections.moveTo(document('b', { driver: 'x', folder: 'A' }), ' ');
    expect(saved[1].value).toEqual({ driver: 'x' });
  });
});
