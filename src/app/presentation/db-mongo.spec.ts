import { describe, expect, it } from 'vitest';
import { renderDeferred } from '../testing/controls';
import { DbPanelTest, installedModule, startDbPanel } from '../testing/db-panel';

const databases = {
  databases: [
    { name: 'shop', empty: false },
    { name: 'admin', empty: false },
  ],
};
const collections = {
  collections: [
    { name: 'orders', kind: 'collection', capped: false },
    { name: 'recent', kind: 'view', viewOn: 'orders', capped: false },
  ],
};

/** The databases section with a MongoDB connection saved before MongoDB was a module. */
async function mongoPanel(module = installedModule('mongodb', 'MongoDB')) {
  return startDbPanel({
    connection: { uri: 'mongodb://db.test:27017/', folder: 'Cloud' },
    modules: [module],
    responses: {
      'mongo.databases': () => databases,
      'mongo.collections': () => collections,
      'mongo.find': () => ({ documents: [{ _id: 1 }], elapsedMs: 1, truncated: false }),
      'mongo.stats': () => ({
        count: 1,
        size: 10,
        storageSize: 10,
        totalIndexSize: 0,
        indexes: [],
        capped: false,
      }),
    },
  });
}

async function shown(panel: DbPanelTest) {
  await panel.settle();
  await renderDeferred(panel.fixture);
  await panel.settle();
}

describe('MongoDB in the databases section', () => {
  it('lists its databases and collections in the same tree, and opens one in its explorer', async () => {
    const panel = await mongoPanel();
    expect(panel.rows()).toEqual(['Cloud', 'Shop']);
    expect(panel.row('Shop').textContent).toContain('MongoDB');
    await panel.open('Shop');
    // The simple view hides the databases of the server itself.
    expect(panel.rows()).toEqual(['Cloud', 'Shop', 'shop']);
    expect(panel.calls('db.connect')).toEqual([]);
    await panel.open('shop');
    expect(panel.rows()).toEqual(['Cloud', 'Shop', 'shop', 'orders', 'recent']);
    expect(panel.row('recent').textContent).toContain('→ orders');
    panel
      .row('orders')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await shown(panel);
    const tab = panel.section().tabs.active()!;
    expect(tab).toMatchObject({ kind: 'mongo', connection: 'c1', path: ['shop', 'orders'] });
    expect(panel.text()).toContain('shop.orders');
    expect(panel.calls('mongo.find').at(-1)).toMatchObject({
      database: 'shop',
      collection: 'orders',
    });
    expect(panel.root().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Shop',
    );
    // Another collection opens in the same tab.
    panel
      .row('recent')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await shown(panel);
    expect(
      panel
        .section()
        .tabs.tabs()
        .filter((each) => each.kind === 'mongo'),
    ).toHaveLength(1);
    expect(panel.text()).toContain('shop.recent');
  });

  it('has its own menu: its explorer, its shell and its form', async () => {
    const panel = await mongoPanel();
    expect(await panel.menuEntries('Shop')).toEqual([
      'Browse data',
      'Shell',
      'Edit connection',
      'Refresh F5',
      'Bookmark',
    ]);
    await panel.menu('Shop', 'Edit connection');
    await shown(panel);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'connection', connection: 'c1' });
    expect(panel.text()).toContain('Paste a connection string');
    expect(panel.text()).toContain('mongodb://db.test:27017/');
    await panel.click('Browse data');
    await shown(panel);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'mongo', connection: 'c1' });
    await panel.click('Edit connection');
    await shown(panel);
    expect(panel.section().tabs.active()?.kind).toBe('connection');
    await panel.menu('Shop', 'Shell');
    await shown(panel);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'mongo', part: 'shell' });
  });

  it('asks to download its module first, saying MongoDB became one', async () => {
    const panel = await mongoPanel({
      ...installedModule('mongodb', 'MongoDB'),
      state: 'available',
    });
    await panel.menu('Shop', 'Browse data');
    await shown(panel);
    const dialog = panel.dialog('MongoDB');
    expect(dialog.textContent).toContain('MongoDB is now a downloadable module');
    await panel.click('Cancel', dialog);
    expect(panel.section().tabs.tabs()).toEqual([]);
  });

  it('starts a new MongoDB connection from the gallery in its own form', async () => {
    const panel = await mongoPanel();
    panel.section().edit();
    await shown(panel);
    await panel.click(/MongoDB/, panel.root().querySelector('.db-gallery') ?? undefined);
    await shown(panel);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'connection', part: 'mongodb' });
    expect(panel.text()).toContain('Import from MongoDB Compass');
  });
});
