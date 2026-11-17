import { describe, expect, it } from 'vitest';
import { DbPanelTest, dbConnection, node, startDbPanel } from '../testing/db-panel';

const tree = {
  '': [node('database', 'shop')],
  shop: [node('folder', 'tables', { label: 'Tables' })],
  'shop/tables': [node('table', 'orders', { detail: '12000 rows' }), node('table', 'users')],
};

async function start() {
  const panel = await startDbPanel({
    tree,
    responses: {
      'db.describe': () => ({ kind: 'table', name: 'orders', properties: [], sections: [] }),
      'db.ddl': () => ({ sql: '' }),
      'db.execute': () => ({ columns: [], rows: [], elapsedMs: 1 }),
    },
  });
  panel.api.documentsStore.push(
    dbConnection({ driver: 'postgres', host: 'b', folder: 'Work' }, 'c2', 'Billing'),
  );
  await panel.state.refresh();
  await panel.settle();
  return panel;
}
async function press(
  panel: DbPanelTest,
  label: string,
  key: string,
  extra: KeyboardEventInit = {},
) {
  panel
    .row(label)
    .dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }),
    );
  await panel.settle();
}
const current = (panel: DbPanelTest) =>
  panel.root().querySelector('[role="treeitem"][tabindex="0"] .db-label')?.textContent?.trim();

describe('the keys and the mouse of the navigator', () => {
  it('moves through the tree with the arrows, Home and End, and opens and closes rows', async () => {
    const panel = await start();
    await press(panel, 'Shop', 'ArrowRight');
    await press(panel, 'Shop', 'ArrowRight');
    await press(panel, 'shop', 'ArrowRight');
    await press(panel, 'shop', 'ArrowRight');
    await press(panel, 'Tables', 'ArrowRight');
    expect(panel.rows()).toContain('orders');
    await press(panel, 'orders', 'ArrowLeft');
    await press(panel, 'Tables', 'ArrowLeft');
    expect(panel.rows()).not.toContain('orders');
    await press(panel, 'Tables', 'ArrowUp');
    await press(panel, 'shop', 'End');
    await press(panel, 'Billing', 'Home');
    await press(panel, 'Shop', 'ArrowDown');
    expect(panel.rows()).toContain('Work');
    await press(panel, 'Work', 'ArrowLeft');
    expect(panel.rows()).not.toContain('Billing');
    await press(panel, 'Work', 'ArrowRight');
    expect(panel.rows()).toContain('Billing');
    expect(current(panel)).toBe('Work');
  });

  it('renames with F2, opens a script with Ctrl+], and its menu with the menu key', async () => {
    const panel = await start();
    await press(panel, 'Shop', 'F2');
    expect(panel.dialog().textContent).toContain('Rename connection');
    await panel.click('Cancel', panel.dialog());
    await press(panel, 'Shop', ']');
    expect(panel.section().tabs.tabs()).toEqual([]);
    await press(panel, 'Shop', ']', { ctrlKey: true });
    expect(panel.section().tabs.active()?.kind).toBe('sql');
    await press(panel, 'Shop', 'ContextMenu');
    expect(panel.root().querySelector('[role="menu"]')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.settle();
    expect(panel.root().querySelector('[role="menu"]')).toBeNull();
    await press(panel, 'Shop', 'F10');
    expect(panel.root().querySelector('[role="menu"]')).toBeNull();
  });

  it('opens a menu with a right click and its kebab, and closes it with Escape', async () => {
    const panel = await start();
    panel.row('Shop').dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 40,
      }),
    );
    await panel.settle();
    const menu = panel.root().querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await panel.settle();
    expect(panel.root().querySelector('[role="menu"]')).toBeNull();
    panel.row('Shop').querySelector<HTMLElement>('.db-kebab')!.click();
    await panel.settle();
    expect(panel.root().querySelector('[role="menu"]')).not.toBeNull();
  });

  it('shows how many rows a table has, collapses everything and reveals a bookmark', async () => {
    const panel = await start();
    await panel.open('Shop', 'shop', 'Tables');
    expect(panel.row('orders').textContent).toMatch(/12\s?K/);
    await panel.menu('orders', /^Bookmark$/);
    await panel.click('Navigator options');
    await panel.click('Collapse all');
    expect(panel.rows()).not.toContain('orders');
    await panel.click('orders', panel.root().querySelector<HTMLElement>('.db-bookmarks')!);
    expect(panel.rows()).toContain('orders');
    await panel.click('Navigator options');
    await panel.click('Navigator options');
    expect(panel.root().querySelector('.db-options-menu')).toBeNull();
  });

  it('moves a connection dragged onto a folder or beside a connection', async () => {
    const panel = await start();
    const drag = async (type: string, label: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', {
        value: { effectAllowed: '', dropEffect: '', setData: () => undefined },
      });
      panel.row(label).dispatchEvent(event);
      await panel.settle();
    };
    await drag('dragover', 'Work');
    await drag('dragstart', 'Shop');
    await drag('dragover', 'Work');
    await drag('drop', 'Work');
    const moved = panel.api.documentsStore.find((document) => document.id === 'c1')!;
    expect((moved.value as { folder?: string }).folder).toBe('Work');
    await drag('dragstart', 'Billing');
    await drag('dragend', 'Billing');
    await drag('drop', 'Shop');
    expect(
      (
        panel.api.documentsStore.find((document) => document.id === 'c2')!.value as {
          folder?: string;
        }
      ).folder,
    ).toBe('Work');
  });
  it('ignores keys while a menu is open, and drags only connections', async () => {
    const panel = await start();
    panel.api.documentsStore.push({
      id: 's1',
      workspace_id: 'local',
      kind: 'sql-script',
      name: 'Totals',
      revision: 1,
      updated_at: 0,
      value: { connectionId: 'c1', sql: 'SELECT 1' },
    });
    await panel.state.refresh();
    await panel.settle();
    panel.state.confirm = () => false;
    await press(panel, 'Totals', 'Delete');
    expect(panel.api.documentsStore.some((document) => document.id === 's1')).toBe(true);
    await press(panel, 'Shop', 'F10', { shiftKey: true });
    await press(panel, 'Shop', 'ArrowDown');
    expect(panel.root().querySelector('[role="menu"]')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.settle();
    panel
      .row('Shop')
      .querySelector<HTMLElement>('.db-kebab')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await panel.settle();
    await panel.click('Navigator options');
    const options = panel.root().querySelector<HTMLElement>('.db-options-menu')!;
    options.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    options.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await panel.settle();
    expect(panel.root().querySelector('.db-options-menu')).toBeNull();
    await panel.open('Shop', 'shop');
    const drag = (type: string, label: string) => {
      panel.row(label).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    };
    drag('dragstart', 'shop');
    drag('dragover', 'Work');
    drag('dragstart', 'Shop');
    drag('dragover', 'shop');
    drag('dragover', 'Work');
    drag('drop', 'shop');
    await panel.settle();
    expect(
      (
        panel.api.documentsStore.find((document) => document.id === 'c1')!.value as {
          folder?: string;
        }
      ).folder,
    ).toBeUndefined();
  });
});
