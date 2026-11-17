import { describe, expect, it } from 'vitest';
import { duration, readLocks, readSessions, shownSessions, waitTree } from './admin';

describe('the administration of a server', () => {
  it('reads sessions and waits defensively', () => {
    expect(readSessions(null)).toEqual({ sessions: [] });
    expect(
      readSessions({
        privilege: 'pg_monitor',
        sessions: [
          { id: 7, user: 'ana', seconds: 1.5, sql: 'SELECT 1', active: true, own: true },
          { id: '8', user: '', seconds: 'soon', state: 'idle', active: 'yes' },
          { user: 'nobody' },
          'nothing',
        ],
      }),
    ).toEqual({
      privilege: 'pg_monitor',
      sessions: [
        { id: '7', user: 'ana', seconds: 1.5, sql: 'SELECT 1', active: true, own: true },
        { id: '8', state: 'idle', active: false, own: false },
      ],
    });
    expect(
      readLocks({ waits: [{ waiting: '9', blocking: '8', seconds: 2, mode: 'X' }, {}] }),
    ).toEqual({ waits: [{ waiting: '9', blocking: '8', seconds: 2, mode: 'X' }] });
    expect(readLocks([])).toEqual({ waits: [] });
  });

  it('hides idle sessions but the own, and finds a text in any field', () => {
    const sessions = [
      { id: '1', user: 'ana', sql: 'SELECT pg_sleep(9)', active: true, own: false },
      { id: '2', user: 'eva', state: 'idle', active: false, own: false },
      { id: '3', user: 'nexo', active: false, own: true },
    ];
    expect(shownSessions(sessions, { text: '', idle: false }).map((s) => s.id)).toEqual(['1', '3']);
    expect(shownSessions(sessions, { text: '', idle: true })).toHaveLength(3);
    expect(shownSessions(sessions, { text: ' SLEEP ', idle: true }).map((s) => s.id)).toEqual([
      '1',
    ]);
    expect(shownSessions(sessions, { text: 'eva', idle: true }).map((s) => s.id)).toEqual(['2']);
  });

  it('puts the session that blocks on top and the ones waiting for it below', () => {
    const rows = waitTree([
      {
        waiting: '12',
        blocking: '10',
        mode: 'ShareLock',
        waitingSql: 'UPDATE b',
        blockingSql: 'UPDATE a',
        blockingUser: 'ana',
      },
      { waiting: '11', blocking: '10', waitingUser: 'eva' },
      { waiting: '13', blocking: '12' },
    ]);
    expect(rows.map((row) => [row.session, row.depth, row.blocks])).toEqual([
      ['10', 0, true],
      ['12', 1, true],
      ['13', 2, false],
      ['11', 1, false],
    ]);
    expect(rows[0]).toMatchObject({ user: 'ana', sql: 'UPDATE a' });
    expect(rows[0].wait).toBeUndefined();
    expect(rows[1]).toMatchObject({ sql: 'UPDATE b', wait: { mode: 'ShareLock' } });
    expect(rows[3].user).toBe('eva');
  });

  it('shows a deadlock once, from the lowest session', () => {
    const rows = waitTree([
      { waiting: '5', blocking: '4' },
      { waiting: '4', blocking: '5' },
    ]);
    expect(rows.map((row) => [row.session, row.depth])).toEqual([
      ['4', 0],
      ['5', 1],
    ]);
    expect(waitTree([])).toEqual([]);
  });

  it('says how long, in seconds, minutes or hours', () => {
    expect(duration(undefined)).toBe('');
    expect(duration(-1)).toBe('');
    expect(duration(4.9)).toBe('4 s');
    expect(duration(185)).toBe('3 min 5 s');
    expect(duration(7_800)).toBe('2 h 10 min');
  });
});
