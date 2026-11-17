import { describe, expect, it } from 'vitest';
import { TABLE_DRAG } from './db-panel/diagrams';
import {
  ORDERS,
  entities,
  entity,
  key,
  openSchema,
  pointer,
  startDiagramPanel,
} from '../testing/db-diagram';
import { DbPanelTest } from '../testing/db-panel';

/** Drops what the navigator carries for a table on the canvas. */
function drop(panel: DbPanelTest, data: unknown, type = 'drop') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = {
    types: [TABLE_DRAG],
    dropEffect: '',
    getData: (kind: string) => (kind === TABLE_DRAG ? JSON.stringify(data) : ''),
  };
  Object.assign(event, { dataTransfer: transfer, clientX: 40, clientY: 30 });
  panel.root().querySelector('.erd-viewport')!.dispatchEvent(event);
  return event;
}

async function newDiagram() {
  const panel = await startDiagramPanel();
  await openSchema(panel);
  await panel.menu('Shop', 'New diagram');
  await panel.settle(20);
  return panel;
}

describe('a diagram of the person', () => {
  it('is created empty, filled from a list of tables or by dropping them, and saved', async () => {
    const panel = await newDiagram();
    const tab = panel.section().tabs.active()!;
    expect(tab).toMatchObject({ kind: 'diagram', connection: 'c1' });
    expect(panel.text()).toContain('Drag tables here from the navigator');
    expect(panel.rows()).toEqual(expect.arrayContaining(['Diagrams', 'Diagram']));

    await panel.click('Add tables');
    await panel.settle(20);
    const picker = panel.dialog('Add tables');
    expect(picker.textContent).toContain('public.users');
    await panel.fill('Filter tables', 'ord', picker);
    expect(picker.textContent).not.toContain('public.users');
    picker.querySelector('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
    picker.querySelector('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
    picker.querySelector('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
    await panel.settle();
    await panel.click(/^Add$/, picker);
    await panel.settle(20);
    expect(entities(panel)).toEqual(['public.orders']);
    await panel.click('Add tables');
    await panel.settle(20);
    expect(panel.dialog('Add tables').textContent).not.toContain('public.orders');
    await panel.click('Cancel', panel.dialog('Add tables'));

    expect(drop(panel, { connection: 'c1', path: ORDERS }, 'dragover').defaultPrevented).toBe(true);
    drop(panel, { connection: 'c1', path: [...ORDERS.slice(0, -1), 'users'] });
    await panel.settle(20);
    expect(entities(panel)).toEqual(['public.orders', 'public.users']);
    expect(panel.root().querySelectorAll('.erd-relation')).toHaveLength(1);
    drop(panel, { connection: 'other', path: ORDERS });
    await panel.settle();
    expect(panel.text()).toContain("Only tables of the diagram's connection can be added.");
    drop(panel, { connection: 'c1' });
    await panel.settle();

    expect(panel.root().querySelector('.db-tab-dirty')).not.toBeNull();
    await panel.fill('Diagram name', 'Sales');
    key(panel.root().querySelector('app-db-diagram')!, 's', { ctrlKey: true });
    await panel.settle(20);
    expect(panel.root().querySelector('.db-tab-dirty')).toBeNull();
    expect(panel.text()).toContain('Sales');
    const saved = panel.section().diagrams.saved()[0];
    expect(saved).toMatchObject({ name: 'Sales', kind: 'db-diagram' });
    expect((saved.value as { entities: unknown[] }).entities).toHaveLength(2);
    expect(panel.rows()).toContain('Sales');
  });

  it('holds notes the person writes, moves and deletes', async () => {
    const panel = await newDiagram();
    await panel.click('Add note');
    await panel.settle();
    const editor = panel.root().querySelector<HTMLTextAreaElement>('.erd-note-editor')!;
    expect(document.activeElement).toBe(editor);
    expect(panel.root().querySelector('.erd-note')!.getAttribute('aria-label')).toBe('Empty note');
    editor.value = 'Billing\nlives here';
    editor.dispatchEvent(new Event('input'));
    key(editor, 'a');
    key(editor, 'Enter', { ctrlKey: true });
    await panel.settle();
    expect(panel.root().querySelector('.erd-note-editor')).toBeNull();
    const note = () => panel.root().querySelector('.erd-note')!;
    expect(note().textContent).toContain('lives here');
    expect(note().getAttribute('aria-label')).toBeNull();
    expect(note().getAttribute('aria-roledescription')).toBe('Note');

    note().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await panel.settle();
    panel.root().querySelector('.erd-note-editor')!.dispatchEvent(new Event('blur'));
    await panel.settle();
    key(note(), 'Enter');
    await panel.settle();
    key(panel.root().querySelector('.erd-note-editor')!, 'Escape');
    await panel.settle();
    pointer(note(), 'pointerdown', { clientX: 0, clientY: 0 });
    pointer(note(), 'pointermove', { clientX: 20, clientY: 0 });
    pointer(note(), 'pointerup');
    key(note(), 'ArrowLeft');
    key(note(), 'Delete');
    await panel.settle();
    expect(panel.root().querySelector('.erd-note')).toBeNull();
  });

  it('asks before closing with changes, opens from the navigator and is deleted there', async () => {
    const panel = await newDiagram();
    const tab = panel.section().tabs.active()!;
    await panel.click('Add note');
    let asked = '';
    panel.state.confirm = (message: string) => {
      asked = message;
      return false;
    };
    panel.section().transactions.requestClose(tab.id);
    await panel.settle();
    expect(asked).toBe('Close the diagram without saving its changes?');
    expect(panel.section().tabs.tabs()).toContain(tab);
    panel.state.confirm = () => true;
    panel.section().transactions.requestClose(tab.id);
    await panel.settle();
    expect(panel.section().tabs.tabs()).not.toContain(tab);

    await panel.menu('Diagram', 'Open');
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'diagram', title: 'Diagram' });
    expect(await panel.menuEntries('Diagram')).toEqual(['Open', 'Delete diagram Del']);
    key(panel.row('Diagram'), 'Delete');
    await panel.settle(20);
    expect(panel.section().diagrams.saved()).toEqual([]);
    expect(panel.rows()).not.toContain('Diagrams');
  });
});

describe('the diagram of a table', () => {
  it('shows the table with those it references and those referencing it', async () => {
    const panel = await startDiagramPanel();
    await openSchema(panel);
    await panel.open('public', 'tables');
    let data = '';
    const start = new Event('dragstart', { bubbles: true });
    Object.assign(start, {
      dataTransfer: {
        setData: (type: string, value: string) => {
          if (type === TABLE_DRAG) data = value;
        },
      },
    });
    panel.row('orders').dispatchEvent(start);
    expect(JSON.parse(data)).toEqual({ connection: 'c1', path: ORDERS });

    await panel.menu('orders', 'View diagram');
    await panel.settle(30);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', part: 'diagram' });
    expect(entities(panel)).toEqual(['public.orders', 'public.users', 'public.lines']);
    expect(panel.root().querySelectorAll('.erd-relation')).toHaveLength(2);
    expect(entity(panel, 'public.lines')).toBeTruthy();
    expect(await panel.menuEntries('public')).toContain('View diagram');
  });

  it('is also in the tab of a schema, and opens the structure editor of a table', async () => {
    const panel = await startDiagramPanel({ opens: true, structure: true });
    await openSchema(panel);
    await panel.menu('public', 'View diagram');
    await panel.settle(30);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', part: 'diagram' });
    expect(entities(panel)).toEqual(['public.orders', 'public.users']);
    expect(panel.buttons('Edit structure…')).toHaveLength(0);
    key(entity(panel, 'public.users'), ' ');
    await panel.settle();
    await panel.click('Edit structure…');
    expect(panel.section().structureRequest()).toMatchObject({
      connection: 'c1',
      mode: 'edit',
      name: 'users',
      path: [...ORDERS.slice(0, -1), 'users'],
    });
  });
});
