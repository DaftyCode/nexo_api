// The collection sidebar of the workspace: folders, requests, dragging and their menus.
import { TEST_API, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton } from '../testing/controls';
import { asCollection } from '../domain/models';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';

describe('Workspace', () => {
  let fixture: ComponentFixture<Workspace>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Workspace],
    }).compileComponents();

    fixture = TestBed.createComponent(Workspace);
    await fixture.whenStable();
  });

  describe('in the sidebar', () => {
    let state: WorkspaceState;
    const root = () => fixture.nativeElement as HTMLElement;
    const settle = async () => {
      for (let i = 0; i < 4; i++) await fixture.whenStable();
    };
    const dialog = () => root().querySelector<HTMLElement>('[role="dialog"]');
    const submit = async (name: string) => {
      const input = dialog()!.querySelector<HTMLInputElement>('input')!;
      input.value = name;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      dialog()!.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click();
      await settle();
    };
    const tree = () =>
      [...root().querySelectorAll('.tree-row')].map((row) =>
        row.querySelector('.request-leaf, .folder-name')?.textContent?.replace(/\s+/g, ' ').trim(),
      );
    const items = () => asCollection(state.collections()[0].value).item;
    const menu = (index: number) => root().querySelectorAll<HTMLElement>('.item-menu')[index];

    beforeEach(async () => {
      state = TestBed.inject(WorkspaceState);
      state.confirm = () => true;
      await state.initialize();
      await settle();
    });

    it('creates a collection and organizes its folders and requests', async () => {
      expect(root().textContent).toContain('Create collection');
      root().querySelector<HTMLButtonElement>('[aria-label="Create collection"]')!.click();
      await fixture.whenStable();
      expect(dialog()?.getAttribute('aria-label')).toBe('Create collection');
      await submit('Shop');
      expect(state.collections().map((c) => c.name)).toEqual(['Shop']);

      const actions = root().querySelector<HTMLElement>('.collection-menu')!;
      await clickButton(fixture, 'Add request', actions);
      await clickButton(fixture, 'Add request', actions);
      await clickButton(fixture, 'Add folder', actions);
      await submit('Orders');
      await settle();
      expect(items().map((item) => item.name)).toEqual(['New request', 'New request', 'Orders']);

      await clickButton(fixture, 'Rename', menu(0));
      expect(dialog()?.getAttribute('aria-label')).toBe('Rename');
      await submit('List orders');
      await clickButton(fixture, 'Move down', menu(0));
      await clickButton(fixture, 'Move up', menu(1));
      await settle();
      expect(items()[0].name).toBe('List orders');

      // The places to move to are listed while the menu is open.
      menu(0).setAttribute('open', '');
      menu(0).dispatchEvent(new Event('toggle'));
      await settle();
      const move = menu(0).querySelector('select')!;
      move.value = [...move.options].find((o) => o.textContent?.trim() === 'Orders')!.value;
      move.dispatchEvent(new Event('change'));
      await settle();
      expect(items().map((item) => item.name)).toEqual(['New request', 'Orders']);
      expect(items()[1].item?.map((item) => item.name)).toEqual(['List orders']);

      const folder = menu(1);
      await clickButton(fixture, 'Add folder', folder);
      await submit('Archive');
      root().querySelector<HTMLButtonElement>('[aria-label="Add request in folder"]')!.click();
      await settle();
      root().querySelector<HTMLButtonElement>('button[aria-label="Orders"]')!.click();
      await fixture.whenStable();
      expect(tree()).toEqual(['GETNew request', 'Orders']);
      root().querySelector<HTMLButtonElement>('button[aria-label="Orders"]')!.click();
      await fixture.whenStable();
      expect(tree()).toContain('GETList orders');

      root().querySelector<HTMLButtonElement>('button[aria-label="Shop"]')!.click();
      await fixture.whenStable();
      expect(tree()).toEqual([]);
      root().querySelector<HTMLButtonElement>('.collection-name')!.click();
      await fixture.whenStable();

      const leaf = [...root().querySelectorAll<HTMLButtonElement>('.request-leaf')].find((button) =>
        button.textContent?.includes('List orders'),
      )!;
      leaf.click();
      await settle();
      expect(state.active()?.request.name).toBe('List orders');

      await clickButton(fixture, 'Variables & settings', menu(1));
      expect(state.settingsPath()).toEqual([1]);
      state.section.set('collections');
      await settle();
      await clickButton(fixture, 'Delete', menu(0));
      await settle();
      expect(items().map((item) => item.name)).toEqual(['Orders']);
    });

    it('moves items by dragging them before, after or inside others', async () => {
      const api = TestBed.inject(TEST_API);
      const collection = (id: string, name: string, item: unknown[]) => ({
        id,
        workspace_id: 'local',
        kind: 'collection',
        name,
        revision: 1,
        updated_at: 0,
        value: { info: { name, schema: 'x' }, item },
      });
      const request = (id: string, name: string) => ({
        id,
        name,
        request: { method: 'GET', url: `http://x/${id}` },
      });
      api.documentsStore.push(
        collection('shop', 'Shop', [
          request('a', 'A'),
          { id: 'o', name: 'Orders', item: [request('b', 'B')] },
          { id: 'r', name: 'Archive', item: [] },
        ]),
        collection('other', 'Other', [request('z', 'Z')]),
      );
      await state.refresh();
      await settle();
      const shop = () => asCollection(state.collections().find((c) => c.id === 'shop')!.value);
      const shape = (items = shop().item): unknown[] =>
        items.map((item) => (item.item ? { [item.name]: shape(item.item) } : item.name));
      const row = (name: string) =>
        [...root().querySelectorAll<HTMLElement>('.tree-row')].find((element) =>
          element.querySelector('.request-leaf, .folder-name')?.textContent?.trim().endsWith(name),
        )!;
      /** A drag event; with no layout, `clientY` is the fraction of the row's height. */
      const fire = (target: Element, type: string, clientY = 0) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, {
          clientY,
          dataTransfer: { setData: () => undefined, effectAllowed: '', dropEffect: '' },
        });
        target.dispatchEvent(event);
        return event;
      };
      const move = async (from: string, to: Element, clientY: number) => {
        fire(row(from), 'dragstart');
        fire(to, 'dragover', clientY);
        await fixture.whenStable();
        const classes = [...to.classList].filter((c) => c.startsWith('drop-'));
        fire(to, 'drop', clientY);
        await settle();
        return classes;
      };

      // Into a folder, by dropping on its middle.
      expect(await move('A', row('Archive'), 0.5)).toEqual(['drop-inside']);
      expect(shape()).toEqual([{ Orders: ['B'] }, { Archive: ['A'] }]);
      expect(state.notice()).toBe('Item moved');

      // A folder into one of its own items: nothing changes and the reason is given.
      expect(await move('Orders', row('B'), 0.1)).toEqual(['drop-before', 'drop-invalid']);
      expect(shape()).toEqual([{ Orders: ['B'] }, { Archive: ['A'] }]);
      expect(state.notice()).toBe('A folder cannot be moved into itself');

      // After a folder, by dropping on its bottom edge: out to the collection.
      expect(await move('B', row('Orders'), 0.9)).toEqual(['drop-after']);
      expect(shape()).toEqual([{ Orders: [] }, 'B', { Archive: ['A'] }]);

      // Before a request, then onto the collection itself: to its end.
      expect(await move('Archive', row('Orders'), 0.1)).toEqual(['drop-before']);
      expect(shape()).toEqual([{ Archive: ['A'] }, { Orders: [] }, 'B']);
      const title = root().querySelector<HTMLElement>('.collection-title')!;
      expect(await move('A', title, 0)).toEqual(['drop-inside']);
      expect(shape()).toEqual([{ Archive: [] }, { Orders: [] }, 'B', 'A']);

      // Dropped where it already is: nothing is saved.
      const saves = api.documentsStore.find((d) => d.id === 'shop')!.revision;
      await move('B', row('B'), 0.9);
      expect(api.documentsStore.find((d) => d.id === 'shop')!.revision).toBe(saves);

      // Into another collection, as in Postman: before its request.
      const other = () => asCollection(state.collections().find((c) => c.id === 'other')!.value);
      expect(await move('A', row('Z'), 0.1)).toEqual(['drop-before']);
      expect(shape()).toEqual([{ Archive: [] }, { Orders: [] }, 'B']);
      expect(shape(other().item)).toEqual(['A', 'Z']);

      // Collections are dragged by their title, before or after another one.
      const titles = () => [...root().querySelectorAll<HTMLElement>('.collection-title')];
      fire(titles()[1], 'dragstart');
      fire(titles()[0], 'dragover', 0.1);
      await fixture.whenStable();
      expect(titles()[0].getAttribute('data-drop')).toBe('before-y');
      fire(titles()[0], 'drop', 0.1);
      await settle();
      expect(state.collections().map((c) => c.id)).toEqual(['other', 'shop']);

      // Nothing without a drag.
      expect(fire(row('B'), 'dragover', 0.1).defaultPrevented).toBe(false);
      expect(fire(row('B'), 'drop', 0.1).defaultPrevented).toBe(false);
      fire(row('A'), 'dragstart');
      fire(row('B'), 'dragover', 0.1);
      await fixture.whenStable();
      fire(row('B'), 'dragleave');
      await fixture.whenStable();
      expect(root().querySelector('[class*="drop-"]')).toBeNull();
    });

    it('exports, duplicates, runs and deletes a collection', async () => {
      const api = TestBed.inject(TEST_API);
      await state.createCollection('Shop');
      await settle();
      const actions = () => root().querySelector<HTMLElement>('.collection-menu')!;
      await clickButton(fixture, 'Export collection', actions());
      expect(api.downloads.map((download) => download.name)).toEqual(['Shop.collection.json']);
      await clickButton(fixture, 'Duplicate', actions());
      await settle();
      expect(
        state
          .collections()
          .map((c) => c.name)
          .sort(),
      ).toEqual(['Shop', 'Shop copy']);
      await clickButton(fixture, 'Variables & settings', actions());
      expect(state.settingsCollectionId()).toBe(state.collections()[0].id);
      state.section.set('collections');
      await settle();
      await clickButton(fixture, 'Run collection', actions());
      expect(state.section()).toBe('runner');
      state.section.set('collections');
      await settle();
      await clickButton(fixture, 'Delete collection', actions());
      await settle();
      expect(state.collections()).toHaveLength(1);
    });

    it('opens and closes the actions menus', async () => {
      await state.createCollection('Shop');
      await settle();
      const menus = root().querySelectorAll<HTMLDetailsElement>('details.collection-menu');
      menus[0].open = true;
      menus[0].dispatchEvent(new Event('toggle'));
      expect(menus[0].dataset['placed']).toBe('');
      // jsdom lays nothing out, so the menu's button counts as scrolled out of sight.
      root().querySelector<HTMLElement>('aside.sidebar')!.dispatchEvent(new Event('scroll'));
      expect(menus[0].open).toBe(false);
      menus[0].open = true;
      menus[0].querySelector('div')!.click();
      expect(menus[0].open).toBe(true);
      root().querySelector<HTMLElement>('.sidebar-heading')!.click();
      expect(menus[0].open).toBe(false);
      menus[0].dispatchEvent(new Event('toggle'));
      expect(menus[0].dataset['placed']).toBeUndefined();
      menus[0].open = true;
      window.dispatchEvent(new Event('resize'));
      expect(menus[0].open).toBe(false);
      menus[0].open = true;
      clickButton(fixture, 'Duplicate', menus[0]);
      expect(menus[0].open).toBe(false);
    });

    it('filters collections and lists the history', async () => {
      await state.createCollection('Shop');
      await state.createCollection('Billing');
      await settle();
      const filter = root().querySelector<HTMLInputElement>('[aria-label="Filter collections"]')!;
      filter.value = 'bill';
      filter.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(state.filter()).toBe('bill');
      state.section.set('history');
      await settle();
      expect(root().textContent).toContain('Your requests will appear here');
    });
  });
});
