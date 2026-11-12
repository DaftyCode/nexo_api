// End-to-end test of MongoDB change streams in the protocols panel: a collection of a replica
// set watched while the API inserts, updates and deletes a document, the three changes shown
// in order.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('MongoDB: a change stream shows an insert, an update and a delete in order', async ({
  page,
  nexo,
}) => {
  const uri = process.env.NEXO_MONGO_REPLICA_SET;
  test.skip(!uri, 'Needs the MongoDB replica set of tools/mongo-fixture.sh');
  await nexo.signIn(page);
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  await sections.getByRole('button', { name: 'MongoDB' }).click();
  const editor = page.getByRole('region', { name: 'Connection', exact: true });
  await editor.getByLabel('Paste a connection string').fill(uri);
  await editor.getByRole('button', { name: 'Use URI' }).click();
  await editor.getByLabel('Connection name').fill('Replica');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Connections' }).getByRole('button', { name: 'Replica' }),
  ).toBeVisible();

  const database = `e2e_watch_${Date.now()}`;
  await sections.getByRole('button', { name: 'Protocols' }).click();
  await page.getByLabel('Protocol', { exact: true }).selectOption('mongodb');
  await page.getByLabel('MongoDB connection').selectOption({ label: 'Replica' });
  await page.getByLabel('Database', { exact: true }).fill(database);
  await page.getByLabel('Collection', { exact: true }).fill('items');
  await page.getByLabel('Document after the change').selectOption('updateLookup');
  await expect(page.getByText(`Replica · ${database}.items`)).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: /Connect/ }).click();
  await expect(page.locator('.stream-event').filter({ hasText: 'open' })).toBeVisible();

  // The API writes, as a request under test would.
  const address = (path) => new URL(path, page.url()).href;
  const execute = async (operation, payload) => {
    const response = await page.request.post(address(`/api/execute/${operation}`), {
      headers: { 'x-nexo-client': 'nexo' },
      data: { workspace: 'local', connection: { uri }, database, collection: 'items', ...payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const documents = await page.request.get(
    address('/api/documents?workspace=local&kind=connection'),
    {
      headers: { 'x-nexo-client': 'nexo' },
    },
  );
  const saved = (await documents.json()).find((document) => document.name === 'Replica');
  const write = (operation, payload) => execute(operation, { connectionId: saved.id, ...payload });
  await write('mongo.insert', { documents: [{ _id: 1, n: 1 }] });
  await write('mongo.update', { filter: { _id: 1 }, update: { $set: { n: 2 } } });
  await write('mongo.delete', { filter: { _id: 1 } });

  const changes = page.locator('.stream-event').filter({ hasText: /insert|update|delete/ });
  await expect(changes).toHaveCount(3);
  await expect(changes.locator('.status-pill')).toHaveText(['insert', 'update', 'delete']);
  await expect(changes.nth(1)).toContainText('"updatedFields"');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  const response = await page.request.post(address('/api/execute/mongo.database.drop'), {
    headers: { 'x-nexo-client': 'nexo' },
    data: {
      workspace: 'local',
      connection: { uri },
      connectionId: saved.id,
      database,
      confirm: database,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);

  // The tests share one server: the connection does not stay for the next one.
  await sections.getByRole('button', { name: 'MongoDB' }).click();
  const list = page.getByRole('navigation', { name: 'Connections' });
  await list.getByRole('button', { name: 'Replica', exact: true }).click();
  page.once('dialog', (confirm) => confirm.accept());
  await editor.getByRole('button', { name: 'Delete connection' }).click();
  await expect(list.getByRole('button', { name: 'Replica', exact: true })).toHaveCount(0);
});
