import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutKey } from '../domain/db/erd-document';
import {
  choose,
  entities,
  entity,
  key,
  openSchema,
  placeOf,
  pointer,
  startDiagramPanel,
} from '../testing/db-diagram';
import { DbPanelTest } from '../testing/db-panel';

async function schemaDiagram() {
  const panel = await startDiagramPanel();
  await openSchema(panel);
  await panel.menu('public', 'View diagram');
  await panel.settle(20);
  return panel;
}
const layout = (panel: DbPanelTest) =>
  panel.section().diagrams.layouts()[layoutKey('c1', ['shop', 'schemas', 'public'])];

describe('DbDiagram', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws the tables of a schema, related, and changes how they are drawn', async () => {
    const panel = await schemaDiagram();
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'diagram', title: 'public' });
    expect(panel.text()).toContain('Diagram: public');
    expect(entities(panel)).toEqual(['public.orders', 'public.users']);
    expect(panel.root().querySelectorAll('.erd-relation')).toHaveLength(1);
    expect(entity(panel, 'public.orders').getAttribute('aria-roledescription')).toBe('Table');
    expect(entity(panel, 'public.orders').textContent).toMatch(/^orders\s*PK\s*id/);
    expect(entity(panel, 'public.users').textContent).toContain('name  text');

    choose(panel.control('Notation'), 'uml');
    await panel.settle();
    expect(panel.root().querySelector('.erd-label')?.textContent).toBe('*');
    choose(panel.control('Columns shown'), 'none');
    await panel.settle();
    expect(entity(panel, 'public.orders').querySelectorAll('.erd-column')).toHaveLength(0);
    choose(panel.control('Columns shown'), 'all');
    panel.control('Types and nullability').dispatchEvent(new Event('change'));
    (panel.control('Types and nullability') as HTMLInputElement).checked = false;
    panel.control('Types and nullability').dispatchEvent(new Event('change'));
    await panel.settle();
    expect(entity(panel, 'public.users').textContent).not.toContain('text');
    expect(layout(panel)).toMatchObject({ notation: 'uml', detail: 'all', types: false });

    await panel.click('Grid layout');
    expect(Object.keys(layout(panel).positions)).toHaveLength(2);
    await panel.click('Layered layout');
    expect(placeOf(entity(panel, 'public.users')).x).toBeLessThan(
      placeOf(entity(panel, 'public.orders')).x,
    );
  });

  it('opens again as it was left, from the layout kept in the session', async () => {
    const panel = await startDiagramPanel();
    await openSchema(panel);
    panel.section().diagrams.keep('c1', ['shop', 'schemas', 'public'], {
      positions: { 'public.users': { x: 900, y: 40 } },
      notation: 'uml',
      detail: 'keys',
      types: false,
    });
    await panel.menu('public', 'View diagram');
    await panel.settle(20);
    expect(entities(panel)).toEqual(['public.orders', 'public.users']);
    expect(placeOf(entity(panel, 'public.users'))).toEqual({ x: 900, y: 40 });
    expect((panel.control('Notation') as HTMLSelectElement).value).toBe('uml');
    expect(panel.root().querySelector('.erd-zoom')?.textContent?.trim()).toMatch(/%$/);
  });

  it('moves, hides, colors and opens tables with the keyboard', async () => {
    const panel = await schemaDiagram();
    const orders = entity(panel, 'public.orders');
    const before = placeOf(orders);
    key(orders, 'ArrowRight');
    key(orders, 'ArrowDown', { shiftKey: true });
    await panel.settle();
    expect(placeOf(entity(panel, 'public.orders'))).toEqual({ x: before.x + 10, y: before.y + 50 });
    expect(layout(panel).positions['public.orders']).toEqual({
      x: before.x + 10,
      y: before.y + 50,
    });

    key(entity(panel, 'public.orders'), ' ');
    key(entity(panel, 'public.users'), ' ', { ctrlKey: true });
    await panel.settle();
    expect(panel.section().tabs.active()?.kind).toBe('diagram');
    choose(panel.control('Color of the tables selected'), 'success');
    await panel.settle();
    expect(entity(panel, 'public.orders').getAttribute('data-color')).toBe('success');
    choose(panel.control('Color of the tables selected'), 'none');
    choose(panel.control('Color of the tables selected'), '');
    await panel.settle();
    expect(entity(panel, 'public.users').getAttribute('data-color')).toBeNull();

    key(entity(panel, 'public.users'), 'Delete');
    await panel.settle();
    expect(entities(panel)).toEqual([]);
    await panel.click(/Show hidden \(2\)/);
    expect(entities(panel)).toHaveLength(2);
    key(entity(panel, 'public.users'), 'Delete');
    await panel.settle();
    expect(entities(panel)).toEqual(['public.orders']);
    await panel.click(/Show hidden/);

    key(entity(panel, 'public.users'), 'Enter');
    await panel.settle();
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', title: 'users' });
  });

  it('finds a table, zooms, scrolls, drags and lights up a relation with the mouse', async () => {
    const panel = await schemaDiagram();
    await panel.fill('Find a table', 'user');
    key(panel.control('Find a table'), 'Enter');
    await panel.settle();
    expect(entity(panel, 'public.users').classList).toContain('erd-found');
    expect(panel.section().diagrams.draft(panel.section().tabs.active()!).selected()).toEqual(
      new Set(['public.users']),
    );
    key(panel.control('Find a table'), 'a');

    const zoom = () => panel.root().querySelector('.erd-zoom')?.textContent?.trim();
    panel.root().querySelector<HTMLElement>('.erd-zoom')!.click();
    await panel.settle();
    expect(zoom()).toBe('100%');
    await panel.click('Zoom in');
    expect(zoom()).toBe('120%');
    await panel.click('Zoom out');
    await panel.click('Fit to window');
    const viewport = panel.root().querySelector('.erd-viewport')!;
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: 10, clientY: 10 }));
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, clientX: 10, clientY: 10 }));
    key(viewport, '+');
    key(viewport, '-');
    key(viewport, 'a', { ctrlKey: true });
    await panel.settle();
    const draft = panel.section().diagrams.draft(panel.section().tabs.active()!);
    expect(draft.selected().size).toBe(2);
    key(viewport, 'Escape');
    key(viewport, 'x');
    expect(draft.selected().size).toBe(0);

    const pan = draft.pan();
    pointer(viewport, 'pointerdown', { clientX: 100, clientY: 100 });
    pointer(viewport, 'pointermove', { clientX: 100, clientY: 100 });
    pointer(viewport, 'pointermove', { clientX: 130, clientY: 90 });
    pointer(viewport, 'pointerup');
    expect(draft.pan()).toEqual({ x: pan.x + 30, y: pan.y - 10 });
    pointer(viewport, 'pointermove', { clientX: 1, clientY: 1 });
    pointer(viewport, 'pointerdown', { button: 2 });

    const orders = entity(panel, 'public.orders');
    const before = placeOf(orders);
    pointer(orders, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(orders, 'pointermove', { clientX: 10 + 40 * draft.zoom(), clientY: 10 });
    pointer(orders, 'pointerup');
    await panel.settle();
    expect(placeOf(entity(panel, 'public.orders')).x).toBeCloseTo(before.x + 40);
    expect(layout(panel).positions['public.orders']).toBeDefined();
    pointer(entity(panel, 'public.users'), 'pointerdown', { shiftKey: true });
    pointer(entity(panel, 'public.users'), 'pointerup');
    expect(draft.selected()).toEqual(new Set(['public.orders', 'public.users']));

    panel.root().querySelector('.erd-relation')!.dispatchEvent(new MouseEvent('click'));
    await panel.settle();
    expect(panel.root().querySelector('.erd-relation.erd-lit')).not.toBeNull();
    expect(panel.root().querySelectorAll('.erd-column.erd-lit')).toHaveLength(2);

    const minimap = panel.root().querySelector('.erd-minimap')!;
    pointer(minimap, 'pointerdown', { clientX: 5, clientY: 5 });
    pointer(minimap, 'pointermove', { clientX: 6, clientY: 6, buttons: 1 });
    pointer(minimap, 'pointermove', { clientX: 60, clientY: 60, buttons: 0 });
    expect(draft.pan()).not.toEqual(pan);

    entity(panel, 'public.users').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await panel.settle();
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', title: 'users' });
  });

  it('shows the diagram as a list, and exports it as SVG and PNG or prints it', async () => {
    const panel = await schemaDiagram();
    await panel.click('As a list');
    const list = panel.root().querySelector('app-db-diagram-list')!;
    expect(list.textContent).toContain('Tables (2)');
    expect(list.textContent).toContain('public.orders (user_id) → public.users (id)');
    await panel.click('orders_user_id_fkey', list);
    expect(list.querySelector('[aria-pressed="true"]')).not.toBeNull();
    await panel.click('Hide', list);
    expect(panel.root().querySelector('app-db-diagram-list')?.textContent).toContain('Tables (1)');
    await panel.click('public.users', panel.root().querySelector('app-db-diagram-list')!);
    expect(panel.section().tabs.active()?.kind).toBe('object');
    panel.section().tabs.activeId.set(panel.section().tabs.tabs()[0].id);
    await panel.settle();
    await panel.click('As a list');

    const download = vi.spyOn(panel.state, 'download').mockResolvedValue(true);
    await panel.click('SVG');
    expect(download).toHaveBeenCalledWith(
      'public.svg',
      expect.stringContaining('<svg'),
      'image/svg+xml',
    );
    expect(download.mock.calls[0][1]).toContain('users');

    vi.stubGlobal(
      'Image',
      class {
        onload?: () => void;
        set src(_: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const drawn = { scale: vi.fn(), drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawn as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) =>
      done(new Blob(['png'])),
    );
    await panel.click('PNG');
    await panel.settle();
    expect(download).toHaveBeenLastCalledWith('public.png', expect.any(Blob), 'image/png');
    expect(drawn.drawImage).toHaveBeenCalled();
    vi.unstubAllGlobals();

    await panel.click('Print');
    expect(panel.state.report()).toMatchObject({
      kind: 'diagram',
      title: 'public',
      diagram: { entities: 1, relations: 0 },
    });
    expect((panel.state.report() as { diagram: { image: string } }).diagram.image).toMatch(
      /^data:image\/svg\+xml/,
    );
  });
});
