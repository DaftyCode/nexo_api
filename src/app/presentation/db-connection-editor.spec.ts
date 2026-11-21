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

  it('goes through a SOCKS5 proxy or an SSH profile, and tests the tunnel alone', async () => {
    const asked: Record<string, unknown>[] = [];
    const panel = await startDbPanel({
      responses: {
        'db.route.test': (payload: Record<string, unknown>) => {
          asked.push(payload);
          return { host: 'db', port: 5432, via: 'socks5', ms: 7 };
        },
      },
    });
    await edit(panel);
    await panel.click('Network', editor(panel));
    expect(panel.buttons('Test the tunnel', editor(panel))).toHaveLength(0);
    const via = panel.control('Connect through', editor(panel)) as HTMLSelectElement;
    expect([...via.options].map((option) => option.value)).toEqual(['direct', 'socks5', 'ssh']);
    via.value = 'socks5';
    via.dispatchEvent(new Event('input'));
    await panel.settle();
    await panel.fill('Proxy host', 'proxy', editor(panel));
    await panel.fill('Proxy user', 'ana', editor(panel));
    await panel.fill('Proxy password', 'pw', editor(panel));
    await panel.click('Test the tunnel', editor(panel));
    expect(panel.text()).toContain('db:5432 reached through the tunnel in 7 ms.');
    expect(asked[0]).toMatchObject({
      port: 5432,
      connection: { route: { via: 'socks5', host: 'proxy', password: '{{vault:db-proxy:c1}}' } },
    });
    expect(panel.api.secretNames).toContain('db-proxy:c1');
    await panel.click(/^Save$/, editor(panel));
    const saved = panel.api.documentsStore.find((document) => document.id === 'c1');
    expect((saved?.value as { route?: unknown }).route).toMatchObject({ via: 'socks5' });
    expect(panel.text()).toContain('Leave the proxy password blank to keep the saved one.');
  });

  it('has no network tab for a database file, and its startup tab keeps no times', async () => {
    const panel = await startDbPanel({ connection: { driver: 'sqlite', database: '/a.db' } });
    await edit(panel);
    expect(panel.buttons('Network', editor(panel))).toHaveLength(0);
    await panel.click('Startup', editor(panel));
    expect(panel.text()).not.toContain('Keep alive every');
    expect(panel.text()).not.toContain('Default schema');
    expect(panel.text()).toContain('Close when unused for');
  });

  it('keeps the startup queries and how the connection is kept', async () => {
    const panel = await start();
    await edit(panel);
    await panel.click('Startup', editor(panel));
    await panel.fill('Default schema (several, with commas)', 'sales', editor(panel));
    await panel.click('+ Add startup query', editor(panel));
    await panel.click('+ Add startup query', editor(panel));
    await panel.fill('Startup query 1', 'SET a = 1', editor(panel));
    await panel.click('Remove startup query 2', editor(panel));
    const lenient = 'Open the session even if a startup query fails';
    (panel.control(lenient, editor(panel)) as HTMLInputElement).click();
    await panel.fill('Keep alive every (seconds, 0 for never)', '60', editor(panel));
    await panel.fill('Close when unused for (minutes, 0 for ten)', '3', editor(panel));
    await panel.fill('Time to connect (seconds, 0 for the driver’s)', '20', editor(panel));
    await panel.click(/^Save$/, editor(panel));
    const saved = panel.api.documentsStore.find((document) => document.id === 'c1');
    expect(saved?.value).toMatchObject({
      defaultSchema: 'sales',
      startupQueries: ['SET a = 1'],
      ignoreStartupErrors: true,
      keepAliveSeconds: 60,
      idleMinutes: 3,
      connectTimeoutSeconds: 20,
    });
    await panel.fill('Keep alive every (seconds, 0 for never)', '2', editor(panel));
    await panel.click('Test connection', editor(panel));
    expect(panel.text()).toContain('Keep alive is from 5 to 600 seconds, or 0 for none');
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
