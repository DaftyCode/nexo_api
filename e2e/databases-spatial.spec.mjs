// End-to-end test of the spatial viewer (DB-29) against the fixture's PostGIS: a table of
// points, lines and polygons is drawn whole with no request outside Nexo, choosing a figure
// shows its row, the list has every geometry, and axe finds nothing serious.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

test('a PostGIS table is drawn on a canvas without a background map', async ({ page, nexo }) => {
  test.setTimeout(120_000);
  test.skip(!environment.NEXO_SQL_POSTGIS_PORT, 'Start the SQL fixture: tools/sql-fixture.sh');
  test.skip(!nexo.moduleIds.includes('postgres'), 'Build the PostgreSQL driver');
  const outside = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http'))
      outside.push(request.url());
  });
  await nexo.signIn(page);
  await addConnection(page, 'Places', {
    label: 'PostgreSQL',
    url: () =>
      `postgresql://${environment.NEXO_SQL_PG_USER}:${environment.NEXO_SQL_PG_PASSWORD}@127.0.0.1:${environment.NEXO_SQL_POSTGIS_PORT}/${environment.NEXO_SQL_PG_DATABASE}`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Places/ }).focus();
  await page.keyboard.press('ArrowRight');
  await newScript(page);
  await write(page, 'SELECT id, name, kind, shape FROM public.places ORDER BY id');
  await page.keyboard.press('ControlOrMeta+Enter');
  const grid = page.locator('app-data-grid');
  await expect(grid).toContainText('SRID=4326;POINT (-77.0428 -12.0464)');
  await page
    .getByRole('navigation', { name: 'Result views' })
    .getByRole('button', { name: 'Spatial' })
    .click();
  const spatial = page.locator('app-db-spatial');
  await expect(spatial.getByRole('img', { name: '5 geometries' })).toBeVisible();
  await expect(spatial.locator('circle')).toHaveCount(3);
  await expect(spatial.locator('path')).toHaveCount(2);
  expect(await violations(page)).toEqual([]);
  await spatial.locator('path.sp-area').click();
  await expect(spatial.getByRole('status')).toContainText('name: Park');
  await spatial.getByRole('button', { name: 'Show as a list' }).click();
  await expect(spatial.getByRole('table')).toContainText('Polygon');
  expect(await violations(page)).toEqual([]);
  expect(outside).toEqual([]);
});
