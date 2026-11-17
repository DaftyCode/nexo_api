import { describe, expect, it } from 'vitest';
import { readDatabaseSession, restoredDrafts, storedDrafts } from './session';

describe('the stored session of the database section', () => {
  it('reads the filter and order of a Data tab, leaving out what is wrong', () => {
    const session = readDatabaseSession({
      tabs: [
        {
          id: 't1',
          kind: 'object',
          connection: 'c',
          title: 'orders',
          path: ['shop', 1, 'orders'],
          part: 'data',
          query: {
            where: 'id > 1',
            quick: [
              { column: 'a', operator: 'eq', value: 1 },
              { column: 'b', operator: 'null' },
              { column: 'c', operator: 'like', value: 1 },
              { column: 3, operator: 'eq' },
              'nothing',
            ],
            order: [{ column: 'a', descending: true }, { column: 'b' }, { column: 1 }],
          },
        },
        {
          id: 't2',
          kind: 'object',
          connection: 'c',
          title: 'x',
          query: { quick: 'no', order: 'no' },
        },
        { id: 't3', kind: 'unknown' },
        { kind: 'sql' },
      ],
      activeTab: 'gone',
    });
    expect(session.tabs).toEqual([
      {
        id: 't1',
        kind: 'object',
        connection: 'c',
        title: 'orders',
        path: ['shop', 'orders'],
        part: 'data',
        query: {
          where: 'id > 1',
          quick: [
            { column: 'a', operator: 'eq', value: 1 },
            { column: 'b', operator: 'null' },
          ],
          order: [
            { column: 'a', descending: true },
            { column: 'b', descending: false },
          ],
        },
      },
      {
        id: 't2',
        kind: 'object',
        connection: 'c',
        title: 'x',
        path: [],
        query: { where: '', quick: [], order: [] },
      },
    ]);
    expect(session.activeTab).toBe('');
  });

  it('keeps the tabs of the sessions and the locks of a server (DB-21)', () => {
    const session = readDatabaseSession({
      tabs: [
        { id: 'a', kind: 'sessions', connection: 'c', title: 'Sessions', path: ['x'] },
        { id: 'b', kind: 'locks', connection: 'c', title: 'Locks' },
        { id: 'c', kind: 'admin', connection: 'c', title: 'Unknown' },
      ],
    });
    expect(session.tabs).toEqual([
      { id: 'a', kind: 'sessions', connection: 'c', title: 'Sessions' },
      { id: 'b', kind: 'locks', connection: 'c', title: 'Locks' },
    ]);
  });

  it('keeps the drafts of SQL tabs only, each one checked', () => {
    const session = readDatabaseSession({
      tabs: [
        { id: 's1', kind: 'sql', connection: 'c', title: 'SQL' },
        { id: 's2', kind: 'console', connection: 'c', title: 'Console' },
      ],
      activeTab: 's1',
      drafts: {
        s1: { text: 'SELECT 1', cursor: -3, script: 'doc', dirty: true, database: 'shop' },
        s2: { text: 'not kept' },
        s3: { text: 'no tab' },
      },
      simple: false,
      bookmarks: [{ connection: 'c', label: 'x', path: ['a'], kind: 'table' }, { label: 'y' }],
    });
    expect(session.drafts).toEqual({
      s1: { text: 'SELECT 1', cursor: 0, script: 'doc', dirty: true, database: 'shop' },
    });
    expect(session.activeTab).toBe('s1');
    expect(session.simple).toBe(false);
    expect(session.bookmarks).toEqual([
      { connection: 'c', path: ['a'], label: 'x', kind: 'table' },
    ]);
    expect(
      readDatabaseSession({ tabs: [{ id: 's', kind: 'sql' }], drafts: { s: 1 } }).drafts,
    ).toEqual({ s: { text: '', cursor: 0 } });
  });

  it('stores a saved script without its text, and opens it again from its document', () => {
    const drafts = {
      a: { text: 'typed', cursor: 2 },
      b: { text: 'SELECT 1', cursor: 1, script: 'doc-b' },
      c: { text: 'changed', cursor: 0, script: 'doc-c', dirty: true },
      d: { text: '', cursor: 0, script: 'gone' },
    };
    const stored = storedDrafts(drafts);
    expect(stored['b'].text).toBe('');
    expect(stored['c'].text).toBe('changed');
    const scripts: Record<string, string> = { 'doc-b': 'SELECT 1', 'doc-c': 'old' };
    const restored = restoredDrafts(stored, (id) => scripts[id]);
    expect(restored['a']).toEqual(drafts.a);
    expect(restored['b'].text).toBe('SELECT 1');
    expect(restored['c'].text).toBe('changed');
    expect(restored['d']).toEqual({ text: '', cursor: 0, script: undefined, dirty: true });
  });
});
