// End-to-end test of the Ignite module against the fixture's Ignite 3 node
// (tools/nosql-fixture.sh): a connection from a JDBC URL, the tree down to a table's columns
// with its distribution zone, and a query whose rows come by pages of the server's cursor.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

test('an Ignite connection shows its schemas and runs SQL', async ({ page, nexo }) => {
  test.setTimeout(180_000);
  test.skip(
    !nexo.moduleIds.includes('ignite'),
    'Build the Ignite driver: cargo build -p nexo-driver-ignite',
  );
  test.skip(!environment.NEXO_IGNITE_HOST, 'Start the NoSQL fixture: tools/nosql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Cluster', {
    label: 'Apache Ignite',
    url: () =>
      `jdbc:ignite:thin://${environment.NEXO_IGNITE_HOST}:${environment.NEXO_IGNITE_PORT}/SHOP`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('ArrowRight');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(tree.getByRole('treeitem', { name: /^Cluster/ }));
  await open(tree.getByRole('treeitem', { name: /^SHOP/ }));
  await expect(tree.getByRole('treeitem', { name: /^ITEMS/ })).toContainText('SHOP_ZONE');
  expect(await violations(page)).toEqual([]);

  await newScript(page);
  await write(page, 'SELECT ID, NAME FROM ITEMS ORDER BY ID');
  await page.keyboard.press('ControlOrMeta+Enter');
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid.getByRole('gridcell', { name: 'Item 1', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(await violations(page)).toEqual([]);
});
