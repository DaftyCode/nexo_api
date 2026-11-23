// End-to-end test of the Hive module against the fixture's HiveServer2 in HTTP mode
// (tools/nosql-fixture.sh): a connection from a JDBC URL, the tree down to a table's columns,
// and a query whose rows come by pages of the server's cursor.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

test('a Hive connection shows its tables and runs HiveQL', async ({ page, nexo }) => {
  test.setTimeout(180_000);
  test.skip(
    !nexo.moduleIds.includes('hive'),
    'Build the Hive driver: cargo build -p nexo-driver-hive',
  );
  test.skip(!environment.NEXO_HIVE_HOST, 'Start the NoSQL fixture: tools/nosql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Warehouse', {
    label: 'Apache Hive',
    url: () =>
      `jdbc:hive2://${environment.NEXO_HIVE_USER}:${environment.NEXO_HIVE_PASSWORD}@${environment.NEXO_HIVE_HOST}:${environment.NEXO_HIVE_PORT}/default;transportMode=http;httpPath=cliservice`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('ArrowRight');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(tree.getByRole('treeitem', { name: /^Warehouse/ }));
  await expect(tree.getByRole('treeitem', { name: /^default/ })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await newScript(page);
  await write(
    page,
    "SELECT pos AS n FROM (SELECT posexplode(split(space(299), ' ')) AS (pos, val)) t ORDER BY n",
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid.getByRole('gridcell', { name: '0', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  expect(await violations(page)).toEqual([]);
});
