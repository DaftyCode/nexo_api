import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../application/ports';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';

const reached = () => ({
  server: { serverVersion: '18', product: 'PostgreSQL', user: 'ana', tls: false },
  pingMs: 2,
});
async function start(test: (payload: Record<string, unknown>) => unknown = reached) {
  const panel = await startDbPanel({ responses: { 'db.test': test } });
  return panel;
}
async function edit(panel: DbPanelTest) {
  panel.section().edit(panel.section().connection('c1'));
  await panel.settle();
}
const editor = (panel: DbPanelTest) =>
  panel.root().querySelector<HTMLElement>('.db-editor, app-db-connection-editor')!;

describe('the connection editor', () => {
  it('refuses a URL of another engine for a saved connection, and copies its URL', async () => {
    const panel = await start();
    await edit(panel);
    await panel.fill('Paste a connection URL', 'mysql://root@db/shop');
    await panel.click('Use URL');
    expect(panel.text()).toContain('This URL is for another database');
    await panel.click('Dismiss error');
    await panel.fill('Paste a connection URL', 'postgresql://ana@db2/shop');
    await panel.click('Use URL');
    expect(panel.text()).toContain('The form now shows this URL.');
    await panel.fill('Paste a connection URL', ' ');
    await panel.click('Use URL');
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    await panel.click('Copy URL');
    expect(written[0]).toContain('db2');
    expect(panel.text()).toContain('URL copied, without the password');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('says why a form cannot be tested, and the servers a failed test reached', async () => {
    const panel = await start(() => {
      throw new ApiFailure('blocked', 'egress.denied', 400, {
        servers: [
          { host: 'db', port: 5432, allowed: false, addresses: ['10.0.0.1'], reason: 'private' },
        ],
      });
    });
    await edit(panel);
    await panel.fill('Connection name', ' ');
    await panel.click('Test connection');
    expect(panel.text()).toContain('Give the connection a name');
    await panel.fill('Connection name', 'Shop');
    await panel.click('Test connection');
    expect(panel.text()).toContain('db:5432');
    expect(panel.text()).toContain('Blocked by the egress policy');
  });

  it('saves over a connection changed elsewhere when the person agrees', async () => {
    const panel = await start();
    await edit(panel);
    await panel.fill('Connection name', 'Renamed');
    const save = panel.api.save.bind(panel.api);
    let conflicts = 1;
    panel.api.save = async (document) => {
      if (conflicts-- > 0) throw new ApiFailure('changed', 'conflict', 409);
      return save(document);
    };
    await panel.click(/^Save$/, editor(panel));
    expect(panel.api.documentsStore.find((document) => document.id === 'c1')?.name).toBe('Renamed');
    conflicts = 1;
    panel.state.confirm = () => false;
    await panel.fill('Connection name', 'Kept');
    await panel.click(/^Save$/, editor(panel));
    expect(panel.api.documentsStore.find((document) => document.id === 'c1')?.name).toBe('Renamed');
  });

  it('forgets the secrets of a new connection tested but never saved', async () => {
    const panel = await start();
    panel.section().edit();
    await panel.settle();
    await panel.click('PostgreSQL');
    await panel.fill('Paste a connection URL', 'postgresql://ana:secret@db.test/shop');
    await panel.click('Use URL');
    await panel.fill('Connection name', 'New');
    await panel.click('Test connection');
    expect(panel.api.secretNames.length).toBeGreaterThan(0);
    const removed: string[] = [];
    panel.api.removeSecret = async (name) => void removed.push(name);
    await panel.click(/^Close$/);
    expect(removed.some((name) => name.startsWith('db-password:'))).toBe(true);
  });
});
