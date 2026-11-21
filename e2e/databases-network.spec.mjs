// End-to-end test of the «Network» tab of a database connection (DB-25) against the
// PostgreSQL fixture (tools/sql-fixture.sh): the server's name is known only to a local
// SOCKS5 proxy, which asks for a password; the tunnel is tested on its own, then the
// connection, and the saved connection is browsed through the proxy.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { socksProxy } from '../tests/contract/socks-fixture.mjs';

const environment = process.env;

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'network' });

test('a connection goes through a SOCKS5 proxy that alone knows its server', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  const proxy = await socksProxy('proxy-pw', () => ({
    'db.socks': Number(environment.NEXO_SQL_PG_PORT),
  }));
  try {
    await nexo.signIn(page);
    await page
      .getByRole('navigation', { name: 'Workspace sections' })
      .getByRole('button', { name: 'Databases' })
      .click();
    await page.getByRole('toolbar', { name: 'Navigator' }).getByRole('button').first().click();
    await page.getByRole('button', { name: /^PostgreSQL/ }).click();
    const download = page.getByRole('dialog', { name: 'Download the PostgreSQL module' });
    await expect(download.or(page.getByLabel('Paste a connection URL'))).toBeVisible();
    if (await download.isVisible()) {
      await download.getByRole('button', { name: 'Download' }).click();
      await expect(download).toBeHidden();
    }
    const { NEXO_SQL_PG_USER: user, NEXO_SQL_PG_PASSWORD: password } = environment;
    await page
      .getByLabel('Paste a connection URL')
      .fill(`postgresql://${user}:${password}@db.socks:5432/${environment.NEXO_SQL_PG_DATABASE}`);
    await page.getByRole('button', { name: 'Use URL' }).click();
    await page.getByLabel('Connection name').fill('Behind the proxy');

    const settings = page.getByRole('navigation', { name: 'Connection settings' });
    await settings.getByRole('button', { name: 'Network' }).click();
    await page.getByLabel('Connect through').selectOption('socks5');
    await page.getByLabel('Proxy host').fill('127.0.0.1');
    await page.getByLabel('Proxy port').fill(String(proxy.port));
    await page.getByLabel('Proxy user').fill('ana');
    await page.getByLabel('Proxy password').fill('proxy-pw');
    expect(await violations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Test the tunnel' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'reached through the tunnel' }),
    ).toContainText('db.socks:5432');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status', { name: 'Connection test' })).toContainText('Connected');
    expect(proxy.asked).toContain('db.socks:5432');
    expect(proxy.asked).toContain('user ana');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Connection saved' })).toBeVisible();
    await expect(
      page.getByText('Leave the proxy password blank to keep the saved one.'),
    ).toBeVisible();
    const tree = page.getByRole('tree', { name: 'Connections' });
    await tree.getByRole('treeitem', { name: /^Behind the proxy/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(
      tree.getByRole('treeitem', { name: new RegExp(`^${environment.NEXO_SQL_PG_DATABASE}`) }),
    ).toBeVisible();
  } finally {
    proxy.close();
  }
});
