// End-to-end test of the data transfer wizard: on a SQLite file, a table exported to CSV and
// a CSV imported with a row that fails, said by its position; and, with the SQL fixture, a
// PostgreSQL table copied to MySQL, its table created and the types without equivalent said.
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { POSTGRES, addConnection, folder, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'transfer' });

/** Drops a table the test made, typing its name as the confirmation asks. */
async function dropTable(page, connection, qualified, name) {
  await page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${connection}`) })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^New SQL script/ }).click();
  await write(page, `DROP TABLE ${qualified}`);
  await page.keyboard.press('ControlOrMeta+Enter');
  const confirm = page.getByRole('dialog', { name: 'Confirm the statement' });
  await confirm.getByRole('textbox').fill(name);
  await confirm.getByRole('button', { name: 'Run' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator('.db-messages').last()).toContainText(/Done|rows changed/);
}

/** Opens a table's menu in the tree and chooses an entry. */
async function tableMenu(page, table, entry) {
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: new RegExp(`^${table}`) }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: entry }).click();
}

test('a table is exported to CSV and a CSV imported, its failed row said', async ({
  page,
  nexo,
}) => {
  test.setTimeout(150_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('shop.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Tienda', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  await newScript(page);
  await write(
    page,
    `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, price REAL);
INSERT INTO items VALUES (1, 'lamp, LED', 9.5), (2, 'desk', 120), (3, NULL, 45);
SELECT count(*) AS stored FROM items`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Tienda/ }).focus();
  await page.keyboard.press('ArrowRight');
  await folder(tree, 'Tables').focus();
  await page.keyboard.press('ArrowRight');

  await tableMenu(page, 'items', 'Export data…');
  const wizard = page.getByRole('dialog', { name: 'Export data' });
  await expect(wizard).toContainText('items.csv');
  expect(await violations(page)).toEqual([]);
  const downloading = page.waitForEvent('download');
  await wizard.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv).toBe('id,label,price\n1,"lamp, LED",9.5\n2,desk,120\n3,,45\n');
  await expect(wizard).toContainText('3 rows exported.');
  await wizard.getByRole('button', { name: 'Close' }).click();

  const source = test.info().outputPath('more.csv');
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(source, 'id,label,price\n4,chair,45\nfive,stool,12\n6,shelf,80\n'),
  );
  await tableMenu(page, 'items', 'Import data…');
  const importing = page.getByRole('dialog', { name: 'Import data' });
  const choosing = page.waitForEvent('filechooser');
  await importing.getByRole('button', { name: 'Choose a file' }).click();
  await (await choosing).setFiles(source);
  const columns = importing.getByRole('table', { name: 'Columns of the file' });
  await expect(columns).toContainText('stool');
  await expect(importing.getByLabel('Where id goes')).toHaveValue('id');
  // Going on after failures: the bad row is said and the others are written.
  await importing.getByLabel('Stop at the first failure and undo it all').uncheck();
  expect(await violations(page)).toEqual([]);
  await importing.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(importing.getByRole('status')).toContainText('Row 2:');
  await expect(importing.locator('.db-transfer-outcome')).toContainText('2');
  await importing.getByRole('button', { name: 'Close' }).click();

  await write(page, 'SELECT count(*) AS now FROM items');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('grid', { name: 'Rows' }).last()).toContainText('5');
});

test('a PostgreSQL table is copied to MySQL with its table created', async ({ page, nexo }) => {
  test.setTimeout(180_000);
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Origen', POSTGRES);
  await addConnection(page, 'Destino', {
    label: 'MySQL',
    url: () =>
      `mysql://${environment.NEXO_SQL_MYSQL_USER}:${environment.NEXO_SQL_MYSQL_PASSWORD}@${environment.NEXO_SQL_MYSQL_HOST}:${environment.NEXO_SQL_MYSQL_PORT}/${environment.NEXO_SQL_MYSQL_DATABASE}`,
  });
  const table = `copied_${Date.now()}`;
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Origen/ }).click();
  await newScript(page);
  await write(
    page,
    `CREATE TABLE public.${table} (id int PRIMARY KEY, code uuid, total numeric(10,2), made timestamptz, span interval, tags text[]);
INSERT INTO public.${table} VALUES (1, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 9.50, '2026-11-16T10:00:00Z', '1 day', '{a,b}'), (2, NULL, 120, NULL, NULL, NULL);
SELECT count(*) AS stored FROM public.${table}`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();
  // A result exports what its query reads.
  await write(page, `SELECT * FROM public.${table} ORDER BY id`);
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.getByRole('button', { name: 'Export…' }).click();
  const exporting = page.getByRole('dialog', { name: 'Export data' });
  await expect(exporting).toContainText('result.csv');
  await exporting.getByRole('button', { name: 'Cancel' }).click();

  // The copy starts from the table in the tree.
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await tree.getByRole('treeitem', { name: /^Origen/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Refresh/ }).click();
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).first());
  await open(folder(tree, 'Schemas'));
  await open(tree.getByRole('treeitem', { name: 'public', exact: true }));
  await open(folder(tree, 'Tables'));
  await tableMenu(page, table, 'Copy to another connection…');
  const copying = page.getByRole('dialog', { name: 'Copy to another connection' });
  await copying.getByLabel('Target connection').selectOption({ label: 'Destino' });
  const ddl = copying.getByLabel('The table it creates');
  await expect(ddl).toContainText(`CREATE TABLE \`${table}\``);
  await expect(copying).toContainText('code, span, tags');
  expect(await violations(page)).toEqual([]);
  await copying.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(copying.locator('.db-transfer-outcome')).toContainText('2');
  await copying.getByRole('button', { name: 'Close' }).click();
  await dropTable(page, 'Destino', `\`${table}\``, table);
  await dropTable(page, 'Origen', `public.${table}`, table);
});
