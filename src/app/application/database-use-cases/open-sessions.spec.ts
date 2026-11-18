import { describe, expect, it } from 'vitest';
import { DatabaseUseCases, DatabasePorts } from '../database-use-cases';
import type { ExecuteArgs, ExecutionPort, PageExitPort } from '../ports';
import { WorkspaceDocument } from '../../domain/models';
import { VariableScopes } from '../../domain/variables';
import { DbOpenSessions } from './open-sessions';
import type { StatementPorts } from './statements';

function engine(failing: string[] = []) {
  const calls: [string, unknown][] = [];
  const api: ExecutionPort = {
    execute: async <T>(...[operation, payload]: ExecuteArgs) => {
      calls.push([operation, payload]);
      if (failing.includes(operation)) throw new Error(`${operation} failed`);
      return { serverVersion: '18', tls: false } as T;
    },
  };
  return { api, calls };
}

/** A page that leaves when told, recording what it sent then. */
function page() {
  const sent: ExecuteArgs[] = [];
  let leave: (() => boolean) | undefined;
  const exit: PageExitPort = {
    onExit: (listener) => void (leave = listener),
    send: (...args) => void sent.push(args),
  };
  return { exit, sent, leave: () => leave?.() };
}

const connect = (session: string, workspace?: string): ExecuteArgs => [
  'db.connect',
  { connectionId: 'c1', session, ...(workspace ? { workspace } : {}) },
];

describe('DbOpenSessions', () => {
  it('keeps the sessions opened and not closed, and passes every call on', async () => {
    const { api, calls } = engine();
    const sessions = new DbOpenSessions(api);
    await sessions.execute(...connect('tree:c1', 'w'));
    await sessions.execute(...connect('editor:t1', 'w'));
    await sessions.execute('db.tree', { session: 'tree:c1', workspace: 'w' });
    expect(sessions.names()).toEqual(['tree:c1', 'editor:t1']);
    await sessions.execute('db.disconnect', { session: 'tree:c1', workspace: 'w' });
    expect(sessions.names()).toEqual(['editor:t1']);
    expect(calls.map(([operation]) => operation)).toEqual([
      'db.connect',
      'db.connect',
      'db.tree',
      'db.disconnect',
    ]);
  });

  it('forgets a session whose connection fails: the engine closed the old one first', async () => {
    const working = engine();
    const sessions = new DbOpenSessions(working.api);
    await sessions.execute(...connect('tree:c1', 'w'));
    const failing = new DbOpenSessions(engine(['db.connect']).api);
    await expect(failing.execute(...connect('tree:c1', 'w'))).rejects.toThrow('db.connect failed');
    expect(failing.names()).toEqual([]);
    expect(sessions.names()).toEqual(['tree:c1']);
  });

  it('closes every open session when the page goes, and says how many', async () => {
    const sessions = new DbOpenSessions(engine().api);
    const { exit, sent } = page();
    expect(sessions.leave(exit)).toBe(0);
    await sessions.execute(...connect('tree:c1', 'w'));
    await sessions.execute(...connect('editor:t1'));
    expect(sessions.leave(exit)).toBe(2);
    expect(sent).toEqual([
      ['db.disconnect', { session: 'tree:c1', workspace: 'w' }],
      ['db.disconnect', { session: 'editor:t1' }],
    ]);
    expect(sessions.names()).toEqual([]);
    expect(sessions.leave(exit)).toBe(0);
  });
});

describe('DatabaseUseCases leaving the page', () => {
  function cases() {
    const { api } = engine();
    const left = page();
    const ports = api as unknown as DatabasePorts & StatementPorts;
    return { cases: new DatabaseUseCases(ports, undefined, left.exit), left };
  }
  const connection = { id: 'c1', value: { driver: 'postgres' } } as unknown as WorkspaceDocument;
  const scopes: VariableScopes = { environment: [], collection: [], globals: [] };

  it('closes the sessions of the navigator and the editors, once', async () => {
    const { cases: database, left } = cases();
    await database.navigator.connect('w', connection, 'tree:c1', scopes);
    await database.statements.open('w', connection, 'editor:t1', scopes, { manual: false });
    await database.statements.open('w', connection, 'editor:t2', scopes, { manual: false });
    await database.statements.close('w', 'editor:t2');
    expect(left.leave()).toBe(true);
    expect(left.sent).toEqual([
      ['db.disconnect', { session: 'tree:c1', workspace: 'w' }],
      ['db.disconnect', { session: 'editor:t1', workspace: 'w' }],
    ]);
    expect(left.leave()).toBe(false);
  });
});
