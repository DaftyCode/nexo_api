import { describe, expect, it } from 'vitest';
import { databaseCases } from '../testing/database-cases';

describe('the administration use cases', () => {
  it('reads the sessions and the waits of a server on a session', async () => {
    const { cases, named } = databaseCases({
      'db.sessions': { sessions: [{ id: 7, own: true, active: true }], privilege: 'PROCESS' },
      'db.locks': { waits: [{ waiting: '9', blocking: '8' }] },
    });
    expect(await cases.admin.sessions('w', 'tree:c1')).toEqual({
      sessions: [{ id: '7', own: true, active: true }],
      privilege: 'PROCESS',
    });
    expect((await cases.admin.locks('w', 'tree:c1')).waits).toEqual([
      { waiting: '9', blocking: '8' },
    ]);
    expect(named('db.sessions')[0]).toMatchObject({ workspace: 'w', session: 'tree:c1' });
    expect(String(named('db.locks')[0]['statement'])).toMatch(/^admin-\d+$/);
  });

  it('cancels or ends a session, confirmed, with the id typed when asked', async () => {
    const { cases, named } = databaseCases({
      'db.session.kill': (payload: Record<string, unknown>) => ({
        done: payload['target'] !== '0',
      }),
    });
    expect(await cases.admin.kill('w', 's', '42', 'cancel')).toBe(true);
    expect(await cases.admin.kill('w', 's', '0', 'terminate', '0')).toBe(false);
    expect(named('db.session.kill')).toEqual([
      expect.objectContaining({ target: '42', mode: 'cancel', confirm: true }),
      expect.objectContaining({ target: '0', mode: 'terminate', confirmName: '0' }),
    ]);
    expect(named('db.session.kill')[0]['confirmName']).toBeUndefined();
  });
});
