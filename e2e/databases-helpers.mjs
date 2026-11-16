// Steps the end-to-end tests of the database section share.
import { expect } from './fixture.mjs';

const environment = process.env;

/** The fixture's PostgreSQL server, as the wizard offers it and its URL. */
export const POSTGRES = {
  label: 'PostgreSQL',
  url: () =>
    `postgresql://${environment.NEXO_SQL_PG_USER}:${environment.NEXO_SQL_PG_PASSWORD}@${environment.NEXO_SQL_PG_HOST}:${environment.NEXO_SQL_PG_PORT}/${environment.NEXO_SQL_PG_DATABASE}`,
};

/** The fixture's SQL Server, with its JDBC URL (encryption of the login only). */
export const SQL_SERVER = {
  label: 'SQL Server',
  url: () =>
    `jdbc:sqlserver://${environment.NEXO_SQL_MSSQL_HOST}:${environment.NEXO_SQL_MSSQL_PORT};databaseName=${environment.NEXO_SQL_MSSQL_DATABASE};user=${environment.NEXO_SQL_MSSQL_USER};password=${environment.NEXO_SQL_MSSQL_PASSWORD};encrypt=false`,
};

/** A folder of the tree, by its label: once open it also says how many objects it holds. */
export const folder = (tree, label) =>
  tree.getByRole('treeitem', { name: new RegExp(`^${label}(?: \\(\\d+\\))?$`) });

/** Chooses an entry of one of the grid's tools: the `⋯` at the end of its header. */
export async function gridTool(page, entry) {
  await page.getByRole('button', { name: 'Grid tools' }).click();
  await page.getByRole('menuitem', { name: entry, exact: true }).click();
}

/** Opens a new SQL script on the connection last chosen, with the tab bar's `+`. */
export async function newScript(page) {
  await page.getByRole('button', { name: /^New SQL script/ }).click();
}

/** Creates a connection to a fixture's server from the wizard, downloading the module. */
export async function addConnection(page, name, engine = POSTGRES) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Databases' })
    .click();
  await page.getByRole('toolbar', { name: 'Navigator' }).getByRole('button').first().click();
  await page.getByRole('button', { name: new RegExp(`^${engine.label}`) }).click();
  const download = page.getByRole('dialog', { name: `Download the ${engine.label} module` });
  await expect(download.or(page.getByLabel('Paste a connection URL'))).toBeVisible();
  if (await download.isVisible()) {
    await download.getByRole('button', { name: 'Download' }).click();
    await expect(download).toBeHidden();
  }
  await page.getByLabel('Paste a connection URL').fill(engine.url());
  await page.getByRole('button', { name: 'Use URL' }).click();
  await page.getByLabel('Connection name').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Connection saved' })).toBeVisible();
}

/** Replaces the text of the SQL editor, as typing it. */
export async function write(page, text) {
  const editor = page.locator('.cm-content[aria-label="SQL script"]');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
  // Closes the completion list that typing may open.
  await page.keyboard.press('Escape');
}
