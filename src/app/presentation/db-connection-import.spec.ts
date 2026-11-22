import { describe, expect, it } from 'vitest';
import { PGADMIN_SERVERS } from '../testing/db-import-files';
import { startDbPanel } from '../testing/db-panel';

async function openImport() {
  const panel = await startDbPanel({
    connection: { driver: 'postgres', host: 'db', database: 'shop', user: 'ana' },
  });
  await panel.click('Navigator options');
  await panel.click('Import connections…');
  return panel;
}

const choose = async (
  panel: Awaited<ReturnType<typeof startDbPanel>>,
  name: string,
  text: string,
) => {
  const input = panel.dialog('Import connections').querySelector<HTMLInputElement>('input')!;
  Object.defineProperty(input, 'files', { value: [new File([text], name)], configurable: true });
  input.dispatchEvent(new Event('change'));
  await panel.settle();
};

describe('importing and exporting connections', () => {
  it('shows what a file brings before saving it, and saves it', async () => {
    const panel = await openImport();
    await choose(panel, 'servers.json', PGADMIN_SERVERS);
    const dialog = panel.dialog('Import connections');
    expect(dialog.textContent).toContain('From pgAdmin: 2 connections');
    expect(dialog.textContent).toContain('Reports');
    expect(dialog.textContent).toContain(
      'Their passwords did not come: Nexo asks for them when you connect.',
    );
    await panel.click('Import 2 connections');
    const kinds = panel.api.documentsStore.map((document) => document.kind);
    expect(kinds.filter((kind) => kind === 'connection')).toHaveLength(3);
    expect(kinds).toContain('ssh-profile');
    expect(panel.state.toast()).toMatchObject({ params: { v0: '2' } });
    expect(panel.root().querySelector('.db-import-dialog')).toBeNull();
  });

  it('reads pasted URLs, says what it cannot read and what the backend refuses', async () => {
    const panel = await openImport();
    await panel.fill('Or paste URLs or the content of a file', '{"other": true}');
    await panel.click(/^Read$/);
    expect(panel.dialog('Import connections').textContent).toContain(
      'Nexo does not know the connections of this file',
    );
    await panel.fill(
      'Or paste URLs or the content of a file',
      'postgresql://ana@db.example.com/shop\nftp://nowhere',
    );
    await panel.click(/^Read$/);
    const dialog = panel.dialog('Import connections');
    expect(dialog.textContent).toContain('From a list of URLs: 1 connections');
    expect(dialog.textContent).toContain('It is not a URL of a database Nexo knows');
    const save = panel.api.save.bind(panel.api);
    panel.api.save = async (document) => {
      if (document.kind === 'connection') throw new Error('Unknown database driver');
      return save(document);
    };
    await panel.click('Import 1 connections');
    expect(panel.dialog('Import connections').textContent).toContain('Unknown database driver');
    await panel.click('Close');
    expect(panel.root().querySelector('.db-import-dialog')).toBeNull();
  });

  it('exports every connection without its secrets', async () => {
    const panel = await startDbPanel({
      connection: {
        driver: 'postgres',
        host: 'db',
        user: 'ana',
        password: '{{vault:db-password:c1}}',
      },
    });
    await panel.click('Navigator options');
    await panel.click('Export connections');
    const [download] = panel.api.downloads;
    expect(download.name).toBe('nexo-connections.json');
    expect(download.content).not.toContain('vault');
    expect(JSON.parse(download.content).connections[0].value).toMatchObject({ askPassword: true });
  });
});
