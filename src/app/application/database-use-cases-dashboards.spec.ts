import { describe, expect, it } from 'vitest';
import { databaseCases } from '../testing/database-cases';

describe('the dashboard use cases', () => {
  it('asks the driver for its panels and reads one as values by series', async () => {
    const { cases, named } = databaseCases({
      'db.dashboards': { dashboards: [{ id: 'sessions', sql: 'SELECT 1', chart: 'line' }] },
      'db.dashboard.read': { columns: [{ name: 'active' }], rows: [[4]] },
    });
    expect((await cases.dashboards.panels('w', 'dashboard:c1'))[0]).toMatchObject({
      id: 'sessions',
      interval: 5,
    });
    expect(await cases.dashboards.read('w', 'dashboard:c1', 'SELECT 1')).toEqual({ active: 4 });
    expect(named('db.dashboard.read')[0]).toMatchObject({
      session: 'dashboard:c1',
      sql: 'SELECT 1',
    });
    const empty = databaseCases({ 'db.dashboard.read': undefined });
    expect(await empty.cases.dashboards.read('w', 's', 'SELECT 1')).toEqual({});
  });
});
