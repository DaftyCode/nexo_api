// End-to-end tests of GraphQL, Git remotes, MCP and printed reports.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('GraphQL: the schema is loaded and explored, and a subscription receives its results', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.getByLabel('Request URL').fill(`${nexo.echo}/graphql`);
  const configuration = page.getByRole('navigation', { name: 'Request configuration' });
  await configuration.getByRole('button', { name: 'Body' }).click();
  await page.locator('.body-options select').first().selectOption('graphql');
  await page.getByRole('button', { name: 'Load schema' }).click();
  const explorer = page.getByRole('region', { name: 'Schema explorer' });
  await expect(explorer).toContainText('user(id: ID!): User');

  // The query editor (CodeMirror): the explorer inserts at the cursor.
  const query = page.getByLabel('GraphQL query');
  const text = () => query.evaluate((editor) => editor.innerText);
  await query.fill('query {\n  \n}');
  await query.press('Control+Home');
  await query.press('ArrowDown');
  await query.press('End');
  await explorer.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(text).toBe('query {\n  user(id: $id) {\n  \n}\n}');
  await explorer.getByRole('button', { name: 'User', exact: true }).click();
  await expect(explorer).toContainText('name: String');

  // Typing suggests the fields of the selection, with their types; Enter takes one.
  await query.fill('query {\n  ');
  await page.keyboard.type('us');
  const suggestions = page.locator('.cm-tooltip-autocomplete');
  await expect(suggestions).toContainText('user');
  await expect(suggestions).toContainText('User');
  // CodeMirror ignores Enter for 75 ms after the list opens, so a fast Enter is a new line.
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(text).toBe('query {\n  user');
  await page.keyboard.type('(id: "1") { n');
  await expect(suggestions).toContainText('name');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(text).toContain('{ name');
  // A field the schema does not have is marked.
  await query.fill('query { user(id: "1") { nickname } }');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1, { timeout: 5000 });
  expect(await violations(page)).toEqual([]);
  await query.fill('query { user(id: "1") { name } }');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.locator('.response-code')).toContainText('"name": "Ana"');

  // The same endpoint's subscription, in the protocols panel.
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Protocols' })
    .click();
  await page.getByLabel('Protocol', { exact: true }).selectOption('graphql-subscription');
  await page.getByLabel('Connection URL').fill(`${nexo.echo.replace('http', 'ws')}/subscriptions`);
  // Its schema, loaded over HTTP at the same address, suggests the subscription's fields.
  await page.getByRole('button', { name: 'Load schema' }).click();
  await expect(page.getByText('suggested as you type')).toBeVisible();
  const subscription = page.getByLabel('GraphQL subscription');
  await subscription.fill('subscription {\n  ');
  await page.keyboard.type('ti');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('ticks');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Int');
  await page.keyboard.press('Escape');
  await subscription.fill('subscription { ticks }');
  await page.getByRole('button', { name: /Connect/ }).click();
  for (const tick of [1, 2, 3])
    await expect(
      page.locator('.stream-event').filter({ hasText: `"ticks": ${tick}` }),
    ).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: /Connect/ })).toBeVisible();

  // The same subscription over server-sent events, which the server completes.
  await page.getByLabel('Subscription protocol').selectOption('graphql-sse');
  await page.getByLabel('Connection URL').fill(`${nexo.echo}/graphql/stream`);
  await page.getByRole('button', { name: /Connect/ }).click();
  await expect(page.locator('.stream-event').filter({ hasText: 'complete' })).toBeVisible();
  for (const tick of [1, 2, 3])
    await expect(
      page.locator('.stream-event').filter({ hasText: `"ticks": ${tick}` }),
    ).toBeVisible();
});

test('Git remotes refuse unsafe addresses and are added and removed', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Git' })
    .click();
  await page.getByRole('button', { name: 'Initialize' }).click();
  await expect(
    page.locator('.tool-output').filter({ hasText: /Initialized|Reinitialized/ }),
  ).toBeVisible();
  const remotes = page.getByRole('region', { name: 'Remotes' });
  await expect(remotes).toContainText('No remotes.');

  await remotes.getByLabel('Remote URL').fill('ext::sh -c touch% /tmp/pwned');
  await remotes.getByRole('button', { name: 'Add remote' }).click();
  await expect(remotes.getByRole('alert')).toContainText('Use an https:// or ssh:// address');

  await remotes.getByLabel('Remote URL').fill('git@github.com:acme/api.git');
  await remotes.getByRole('button', { name: 'Add remote' }).click();
  await expect(remotes.getByRole('listitem').filter({ hasText: 'origin' })).toContainText(
    'git@github.com:acme/api.git',
  );
  expect(await violations(page)).toEqual([]);

  page.once('dialog', (confirm) => confirm.accept());
  await remotes.getByRole('button', { name: 'Remove remote origin' }).click();
  await expect(remotes).toContainText('No remotes.');
});

test('MCP: the resources and prompts of a server are browsed', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MCP' })
    .click();
  await page.getByLabel('Server URL').fill(`${nexo.echo}/mcp`);
  await page.getByLabel('Method').selectOption('initialize');
  await page.getByRole('button', { name: 'Send JSON-RPC' }).click();
  await expect(page.locator('app-mcp-results')).toContainText('e2e-session');

  await page.getByLabel('Method').selectOption('resources/list');
  await page.getByRole('button', { name: 'Send JSON-RPC' }).click();
  await page.getByRole('button', { name: 'Read Readme' }).click();
  await expect(page.getByLabel('docs://readme')).toContainText('Read me first');

  await page.getByLabel('Method').selectOption('prompts/list');
  await page.getByRole('button', { name: 'Send JSON-RPC' }).click();
  const prompt = page.getByRole('region', { name: 'greet' });
  await prompt.getByLabel('name *').fill('Ana');
  await prompt.getByRole('button', { name: 'Get prompt greet' }).click();
  await expect(page.locator('app-mcp-results')).toContainText('Say hello to Ana');
  expect(await violations(page)).toEqual([]);
});

test('reports of a run, a request and a collection are printed to PDF without secrets', async ({
  page,
  nexo,
}) => {
  // The print dialog is the system's: it is counted instead of opened.
  await page.addInitScript(() => {
    window.print = () => {
      window.__printed = (window.__printed ?? 0) + 1;
    };
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nexo.signIn(page);
  const printable = {
    info: { name: 'Printable', description: 'Orders API for the PDF' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'pdf-secret-token' }] },
    item: [
      {
        name: 'Orders',
        description: 'Everything about orders',
        item: [
          {
            name: 'List orders',
            request: { method: 'GET', url: `${nexo.echo}/orders`, description: 'All orders' },
            event: [
              {
                listen: 'test',
                script: {
                  exec: ["pm.test('answers 200', () => pm.response.to.have.status(200));"],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.getByLabel('Import content').fill(JSON.stringify(printable));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  const collection = page.locator('.collection', { hasText: 'Printable' });
  const preview = page.getByRole('dialog', { name: 'Print preview' });
  const paper = preview.locator('.report-paper');

  // Documentation of the collection.
  await collection.getByLabel('Collection actions').click();
  await page.getByRole('button', { name: 'Export documentation (PDF)' }).click();
  await expect(paper).toContainText('Collection documentation');
  await expect(paper).toContainText('Everything about orders');
  await expect(paper).toContainText('All orders');
  await expect(paper).toContainText(`${nexo.echo}/orders`);
  await expect(paper).not.toContainText('pdf-secret-token');
  expect(await violations(page)).toEqual([]);
  await preview.getByRole('button', { name: 'Close', exact: true }).click();

  // A request with its response.
  await collection.locator('.tree-row', { hasText: 'List orders' }).click();
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  await page.locator('app-response-view').getByRole('button', { name: 'Export PDF' }).click();
  await expect(paper).toContainText('Request and response');
  await expect(paper).toContainText('/orders');
  await expect(paper).toContainText('answers 200');
  await preview.getByRole('button', { name: 'Close', exact: true }).click();

  // A run, printed: only the report is on paper, and it makes a PDF.
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Runner' })
    .click();
  await page.getByRole('button', { name: 'Run collection' }).click();
  await expect(page.getByText('Run completed')).toBeVisible();
  await page.locator('app-runner-panel').getByRole('button', { name: 'Export PDF' }).click();
  await expect(paper).toContainText('Collection run report');
  await expect(paper).toContainText('1 passed, 0 failed, 0 skipped');
  // The test is shown under the request that ran it.
  await expect(paper.locator('.report-block', { hasText: 'List orders' })).toContainText(
    'PASS · answers 200',
  );
  await expect(paper).not.toContainText('Other tests');
  await preview.getByRole('button', { name: 'Print or save as PDF' }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('app-root')).toBeHidden();
  await expect(page.locator('body > .print-sheet')).toBeVisible();
  await expect(page.locator('body > .print-sheet')).toContainText('PASS · answers 200');
  const pdf = await page.pdf({ format: 'A4' });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  await page.emulateMedia({ media: 'screen' });
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('body > .print-sheet')).toHaveCount(0);
});
