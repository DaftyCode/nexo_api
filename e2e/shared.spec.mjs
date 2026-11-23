// End-to-end test of a collection shared by the team (C-01): shared from its menu to a
// folder, a teammate's change to the file shows in the tree on its own, the Sharing dialog
// says where its file is, and sharing stops. axe finds nothing serious in the dialogs.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test("a collection shared to a folder shows a teammate's change on its own", async ({
  page,
  nexo,
}) => {
  const folder = await mkdtemp(join(tmpdir(), 'nexo-e2e-shared-'));
  const path = join(folder, 'Team API.nexo-collection');
  try {
    await nexo.signIn(page);
    await page.getByRole('button', { name: 'Create collection' }).first().click();
    await page.getByPlaceholder('Give it a name').fill('Team API');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const collection = page.locator('.collection', { hasText: 'Team API' });
    await expect(collection).toBeVisible();

    await collection.getByLabel('Collection actions').click();
    await collection.getByRole('button', { name: 'Share with the team…' }).click();
    const share = page.getByRole('dialog', { name: 'Share with the team' });
    await share.getByText('How sharing works').click();
    await expect(share).toContainText('Nexo makes no call to the cloud');
    await expect(share.getByLabel('Where its file goes')).toHaveValue('Team API.nexo-collection');
    await share.getByLabel('Where its file goes').fill(path);
    // In the clear, so that the test can write the file as a teammate's Nexo would.
    await share.getByLabel('Encrypt it with a team key').uncheck();
    expect(await violations(page)).toEqual([]);
    await share.getByRole('button', { name: 'Share the collection' }).click();
    await expect(share).toBeHidden();
    const mark = collection.getByRole('button', { name: 'Shared with the team' });
    await expect(mark).toBeVisible();

    // A teammate's Nexo adds a request to the file.
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.nexo).toBe('nexo-shared-collection');
    file.content.collection.item.push({
      id: 'from-ben',
      name: 'Added by Ben',
      request: { method: 'GET', url: 'https://api.test/ben' },
    });
    await writeFile(path, JSON.stringify(file, null, 2));
    await expect(collection.locator('.tree-row', { hasText: 'Added by Ben' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('strong').filter({ hasText: 'Updated from the shared file' }),
    ).toBeVisible();

    await mark.click();
    const sharing = page.getByRole('dialog', { name: 'Sharing' });
    await expect(sharing).toContainText(path);
    expect(await violations(page)).toEqual([]);
    page.once('dialog', (dialog) => dialog.accept());
    await sharing.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(sharing).toBeHidden();
    await expect(mark).toBeHidden();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
