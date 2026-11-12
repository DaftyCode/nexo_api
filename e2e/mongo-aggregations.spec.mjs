// End-to-end test of the Aggregations tab: a pipeline of five stages with $lookup previewed
// stage by stage, run, and written with $out once the collection is named again.
import { expect, test } from './fixture.mjs';
import { deleteMongoConnection, violations } from './helpers.mjs';

test('MongoDB: a pipeline of five stages is previewed stage by stage and written with $out', async ({
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
  await editor.getByLabel('Connection name').fill('Aggregations');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await tree.getByRole('button', { name: /^nexo / }).click();
  await tree.getByRole('button', { name: /^big$/ }).click();
  await query.getByRole('button', { name: 'Aggregations', exact: true }).click();

  const stage = (label) => query.locator(`.cm-content[aria-label="Value of stage ${label}"]`);
  const add = async (operator) => {
    await query.getByLabel('New stage').selectOption(operator);
    await query.getByRole('button', { name: 'Add stage' }).click();
  };
  await stage('1 $match').fill('{n: {$lt: 100}}');
  await add('$lookup');
  await stage('2 $lookup').fill("{from: 'big', localField: 'n', foreignField: '_id', as: 'same'}");
  await add('$unwind');
  await stage('3 $unwind').fill("'$same'");
  await add('$group');
  await stage('4 $group').fill("{_id: '$same.status', orders: {$sum: 1}}");
  await add('$sort');
  await stage('5 $sort').fill('{_id: 1}');

  await query.getByRole('button', { name: 'Preview every stage' }).click();
  for (const label of ['1 $match', '2 $lookup', '3 $unwind', '4 $group', '5 $sort'])
    await expect(
      query.getByRole('region', { name: `Documents after stage ${label}` }),
    ).toContainText('documents after this stage');
  await expect(query.getByRole('region', { name: 'Documents after stage 5 $sort' })).toContainText(
    'The first 4 documents',
  );
  expect(await violations(page)).toEqual([]);

  await query.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(query.getByTestId('aggregation-range')).toContainText('Documents 1 to 4');

  // $out to a database of its own: never previewed, written once confirmed.
  const name = `e2e_aggregate_${Date.now()}`;
  await add('$out');
  await stage('6 $out').fill(`{db: '${name}', coll: 'by_status'}`);
  await query.getByRole('button', { name: 'Preview stage 6 $out' }).click();
  await expect(query.getByRole('region', { name: 'Documents after stage 6 $out' })).toContainText(
    'a preview never runs it',
  );
  await query.getByLabel('Type by_status to confirm').fill('by_status');
  await query.getByRole('button', { name: 'Run and write' }).click();
  await expect(query).toContainText(`Written to ${name}.by_status`);

  await tree.getByRole('button', { name: new RegExp(`^${name} `) }).click();
  await tree.getByRole('button', { name: /^by_status$/ }).click();
  await query.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(query.getByRole('definition').first()).toHaveText('4');
  const dialog = page.getByRole('dialog');
  await query.getByText('Collection', { exact: true }).click();
  await query.getByRole('button', { name: 'Drop database' }).click();
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  await dialog.getByRole('button', { name: 'Drop database' }).click();
  await expect(query).toContainText('Choose a collection to query it.');
  await deleteMongoConnection(page, 'Aggregations');
});
