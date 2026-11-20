// End-to-end test of data masking: a set of rules made and tried in Settings → Masking, and
// a JSON response exported as a CSV file through it, with none of the original values.
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('a response exported through a masking set has none of the values it names', async ({
  page,
  nexo,
}, testInfo) => {
  await nexo.signIn(page);
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  await sections.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Masking', exact: true }).click();
  await page.getByRole('button', { name: 'New masking set' }).click();
  // A name of its own: the server is shared with the other tests.
  await page.getByLabel('Name', { exact: true }).fill('E2E items');
  await page.getByLabel('Field path').fill('item');
  await page.getByLabel('Method').selectOption('hash');
  await page.getByText('Try it on an example').click();
  await page.getByLabel('Example (JSON)').fill('[{"item": 7, "kept": "yes"}]');
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  const tried = page.locator('.mask-result');
  await expect(tried).toContainText('"kept": "yes"');
  await expect(tried).not.toContainText('"item": 7');
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.masking-sets')).toContainText('E2E items');

  // 500 items, each {"item": n}: exported as CSV through the set.
  await sections.getByRole('button', { name: 'Collections' }).click();
  await page.getByLabel('Request URL').fill(`${nexo.echo}/long`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByText('500 records you can export as a table')).toBeVisible();
  await page.getByRole('button', { name: 'Export table…' }).click();
  const form = page.locator('app-table-export form');
  await form.getByLabel('Format').selectOption('csv');
  await form.getByLabel('Masking').selectOption({ label: 'E2E items' });
  expect(await violations(page)).toEqual([]);
  const downloading = page.waitForEvent('download');
  await form.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('response.csv');
  const file = testInfo.outputPath('response.csv');
  await download.saveAs(file);
  const lines = (await readFile(file, 'utf8')).replace(/^﻿/, '').trim().split('\r\n');
  expect(lines[0]).toBe('item');
  expect(lines).toHaveLength(501);
  // Every value is a token; the same value would give the same one.
  expect(lines.slice(1).every((line) => /^[0-9a-f]{16}$/.test(line))).toBe(true);
  expect(new Set(lines.slice(1)).size).toBe(500);
});
