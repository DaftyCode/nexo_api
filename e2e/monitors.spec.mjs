// End-to-end test of monitors: a collection run on a schedule while Nexo is open, run now
// by hand here, with its history of runs and what failed in them.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('a monitor runs a collection now, keeps its history and is deleted with it', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  const collection = {
    info: { name: 'Monitored orders' },
    item: [
      {
        name: 'List orders',
        request: { method: 'GET', url: `${nexo.echo}/orders` },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                "pm.test('answers 200', () => pm.response.to.have.status(200));",
                "pm.test('has two orders', () => pm.expect(1).to.equal(2));",
              ],
            },
          },
        ],
      },
    ],
  };
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.getByLabel('Import content').fill(JSON.stringify(collection));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  await expect(page.locator('.collection', { hasText: 'Monitored orders' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Monitors' })
    .click();
  const panel = page.locator('app-monitors-panel');
  /** The select of a field, by the text its label starts with. */
  const select = (label) =>
    panel.locator('label.field', { hasText: new RegExp(`^${label}`) }).locator('select');
  await expect(panel.getByRole('note')).toContainText('Monitors run only while Nexo is open');
  await panel.getByRole('button', { name: '＋ New monitor' }).click();
  await panel.getByRole('textbox', { name: 'Name' }).fill('Orders watch');
  await select('Collection').selectOption({ label: 'Monitored orders' });
  // Once a day, at midnight: the test runs it by hand.
  await select('Run').selectOption('hours');
  await select('Hours').selectOption('24');
  expect(await violations(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Save monitor' }).click();

  const item = panel.locator('.monitor-item', { hasText: 'Orders watch' });
  await expect(item).toContainText('Every 24 h');
  await expect(panel.locator('.monitor-facts')).toContainText('Monitored orders');
  await expect(panel).toContainText('It has not run yet.');

  await panel.getByRole('button', { name: '▷ Run now' }).click();
  const run = panel.locator('.monitor-run').first();
  await expect(run.locator('.status-pill')).toHaveText('Failed', { timeout: 15_000 });
  await expect(run).toContainText('By hand');
  await expect(run).toContainText('1 requests · 1 assertions passed · 1 failed');
  await run.locator('summary').click();
  await expect(run).toContainText('has two orders');
  expect(await violations(page)).toEqual([]);

  await panel.getByRole('button', { name: 'Pause schedule' }).click();
  await expect(item.locator('.status-pill')).toHaveText('Paused');
  await expect(panel.locator('.monitor-facts')).toContainText('Paused');

  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(item).toHaveCount(0);
});
