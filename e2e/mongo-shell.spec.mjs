// End-to-end test of the MongoDB shell: the usual commands of mongosh against the seeded
// server, and a drop that runs only after the collection's name is typed.
import { expect, test } from './fixture.mjs';
import { deleteMongoConnection, violations } from './helpers.mjs';

test('MongoDB: the shell runs mongosh commands and asks before dropping', async ({
  page,
  nexo,
}) => {
  test.skip(!process.env.NEXO_MONGO_PLAIN, 'Needs the MongoDB servers of tools/mongo-fixture.sh');
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MongoDB' })
    .click();
  const editor = page.getByRole('region', { name: 'Connection', exact: true });
  await editor.getByLabel('Paste a connection string').fill(process.env.NEXO_MONGO_PLAIN);
  await editor.getByRole('button', { name: 'Use URI' }).click();
  await editor.getByLabel('Connection name').fill('Shell');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await tree.getByRole('button', { name: /^nexo / }).click();
  await tree.getByRole('button', { name: 'Shell', exact: true }).click();
  const command = query.locator('.cm-content[aria-label="Shell command"]');
  const output = query.getByRole('log', { name: 'Shell output' });
  const run = async (text) => {
    await command.fill(text);
    await command.press('Control+Enter');
  };

  await run('use nexo\nshow collections');
  await expect(output).toContainText('"big"');
  await expect(query.getByTestId('shell-database')).toHaveText('nexo>');
  await run("db.big.find({ 'customer.address.city': 'Madrid' }).sort({ n: 1 }).limit(2)");
  await expect(output).toContainText('2 documents');
  await expect(output).toContainText('n: 3');
  expect(await violations(page)).toEqual([]);

  const name = `e2e_shell_${Date.now()}`;
  await run(`use ${name}\ndb.items.insertOne({ a: 1 })`);
  await expect(output).toContainText('acknowledged: true');
  await run('db.items.drop()');
  const confirm = query.getByRole('alertdialog', { name: 'Confirm the command' });
  await expect(confirm).toContainText('This command drops or empties the collection items');
  await expect(confirm.getByRole('button', { name: 'Run it' })).toBeDisabled();
  await confirm.getByLabel('Type items to confirm').fill('items');
  await confirm.getByRole('button', { name: 'Run it' }).click();
  await expect(confirm).toHaveCount(0);
  await run('db.dropDatabase()');
  await confirm.getByLabel(`Type ${name} to confirm`).fill(name);
  await confirm.getByRole('button', { name: 'Run it' }).click();
  await expect(output).toContainText(`dropped: "${name}"`);

  // The history keeps the commands of the connection.
  await query.getByText('History', { exact: true }).click();
  await expect(query.getByRole('button', { name: 'db.items.drop()' })).toBeVisible();
  await query.getByRole('button', { name: 'Close the shell' }).click();
  await deleteMongoConnection(page, 'Shell');
});
