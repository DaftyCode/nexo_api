import { TEST_API, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton } from '../testing/controls';
import { asCollection } from '../domain/models';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';

describe('Workspace', () => {
  let component: Workspace;
  let fixture: ComponentFixture<Workspace>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Workspace],
    }).compileComponents();

    fixture = TestBed.createComponent(Workspace);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('changes English and Spanish in every template without changing request data or environment', async () => {
    const state = TestBed.inject(WorkspaceState);
    await state.initialize();
    state.documents.set([
      {
        id: 'env-language-test',
        workspace_id: 'local',
        kind: 'environment',
        name: 'My environment',
        revision: 1,
        updated_at: 1,
        value: { values: [{ key: 'baseUrl', value: 'https://example.test' }] },
      },
    ]);
    state.environmentId.set('env-language-test');
    state.edit({
      ...state.active()!.request,
      url: 'https://example.test/do-not-translate',
      body: '{"message":"Send"}',
    });
    state.response.set({
      status: 200,
      statusText: 'OK',
      time: 1,
      size: 1,
      body: '{"message":"English"}',
      headers: [],
      assertions: [],
      logs: [],
    });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const language = root.querySelector<HTMLSelectElement>(
      'select[aria-label="Language / Idioma"]',
    )!;
    const template = root.querySelector<HTMLSelectElement>('app-appearance-selector select')!;
    for (const layout of ['aurora', 'studio', 'canvas']) {
      template.value = layout;
      template.dispatchEvent(new Event('input', { bubbles: true }));
      template.dispatchEvent(new Event('change', { bubbles: true }));
      await fixture.whenStable();
      for (const [code, send] of [
        ['es', 'Enviar'],
        ['en', 'Send'],
      ]) {
        language.value = code;
        language.dispatchEvent(new Event('input', { bubbles: true }));
        language.dispatchEvent(new Event('change', { bubbles: true }));
        await fixture.whenStable();
        expect(root.querySelector('.url-toolbar .send')?.textContent?.trim()).toBe(send);
        expect(state.active()?.request.url).toBe('https://example.test/do-not-translate');
        expect(state.active()?.request.body).toBe('{"message":"Send"}');
        expect(state.response()?.body).toBe('{"message":"English"}');
        expect(state.environmentId()).toBe('env-language-test');
      }
    }
  });

  it('switches templates immediately without replacing the active request', async () => {
    await TestBed.inject(WorkspaceState).initialize();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const studio = root.querySelector('.studio')!;
    const url = root.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')!;
    const selector = root.querySelector<HTMLSelectElement>('select[aria-label="Visual template"]')!;
    expect(studio.getAttribute('data-template')).toBe('aurora');
    url.value = 'https://example.test/keep-this-request';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(Array.from(selector.options, (option) => option.value)).toEqual([
      'aurora',
      'studio',
      'canvas',
    ]);
    for (const template of ['studio', 'canvas']) {
      selector.value = template;
      selector.dispatchEvent(new Event('input', { bubbles: true }));
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      await fixture.whenStable();
      expect(studio.getAttribute('data-template')).toBe(template);
      expect(root.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')?.value).toBe(
        'https://example.test/keep-this-request',
      );
      expect(
        Array.from(root.querySelectorAll('.rail button'), (button) => button.textContent?.trim()),
      ).toEqual([
        'Collections',
        'Environments',
        'History',
        'Runner',
        'Protocols',
        'Mocks',
        'Datasets',
        'Git',
        'MCP',
        'Settings',
      ]);
    }
    root.querySelector<HTMLButtonElement>('[aria-label="Open workspace tools"]')!.click();
    await fixture.whenStable();
    expect(studio.classList.contains('canvas-navigation-visible')).toBe(true);
    root.querySelector<HTMLButtonElement>('[aria-label="Close workspace navigation"]')!.click();
    await fixture.whenStable();
    expect(studio.classList.contains('canvas-navigation-visible')).toBe(false);
    TestBed.inject(WorkspaceState).section.set('history');
    await fixture.whenStable();
    expect(studio.classList.contains('canvas-navigation-visible')).toBe(true);
    selector.value = 'aurora';
    selector.dispatchEvent(new Event('input', { bubbles: true }));
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(studio.getAttribute('data-template')).toBe('aurora');
    expect(root.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')?.value).toBe(
      'https://example.test/keep-this-request',
    );
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

      const move = menu(0).querySelector('select')!;
      move.value = '2';
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

    it('imports pasted content and files, and creates workspaces', async () => {
      const api = TestBed.inject(TEST_API);
      api.responses['import'] = ({ content }: Record<string, unknown>) => ({
        kind: 'collection',
        name: String(content),
        value: { info: { name: String(content) }, item: [] },
      });
      await clickButton(fixture, 'Import');
      const content = dialog()!.querySelector('textarea')!;
      content.value = 'Pasted';
      content.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      await clickButton(fixture, /^\s*Import\s*$/, dialog()!.querySelector('.modal-actions')!);
      await settle();
      expect(state.error()).toBe('');
      expect(dialog()).toBeNull();
      await clickButton(fixture, 'Import');
      const file = dialog()!.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(file, 'files', { value: [new File(['From file'], 'shop.json')] });
      file.dispatchEvent(new Event('change'));
      await settle();
      expect(
        state
          .collections()
          .map((c) => c.name)
          .sort(),
      ).toEqual(['From file', 'Pasted']);

      root().querySelector<HTMLButtonElement>('[aria-label="Create workspace"]')!.click();
      await fixture.whenStable();
      await submit('Second');
      expect(state.notice()).toBe('Workspace created');
      const select = root().querySelector<HTMLSelectElement>('select[aria-label="Workspace"]')!;
      select.dispatchEvent(new Event('change'));
      await settle();

      await clickButton(fixture, 'Import');
      await clickButton(fixture, 'Cancel', dialog()!);
      expect(dialog()).toBeNull();
    });

    it('answers the keyboard shortcuts', async () => {
      const press = async (key: string, options: KeyboardEventInit = {}) => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, ...options }),
        );
        await settle();
      };
      await press('F1', { ctrlKey: false });
      expect(dialog()?.getAttribute('aria-label')).toBe('Keyboard shortcuts');
      await clickButton(fixture, 'Close', dialog()!);
      await press('/');
      expect(dialog()).not.toBeNull();
      root().querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
      await fixture.whenStable();

      const tabs = state.tabs().length;
      await press('t');
      expect(state.tabs()).toHaveLength(tabs + 1);
      await press('k');
      expect(state.section()).toBe('collections');
      await press('Enter');
      expect(state.error()).toBe('Enter a request URL');
      await press('s');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    it('switches, closes and adds request tabs and shows the console', async () => {
      await clickButton(fixture, 'New request tab');
      await clickButton(fixture, 'New');
      expect(state.tabs().length).toBeGreaterThanOrEqual(3);
      const [first] = root().querySelectorAll<HTMLElement>('.request-tab button');
      first.click();
      await fixture.whenStable();
      expect(state.activeTabId()).toBe(state.tabs()[0].id);
      root().querySelector<HTMLButtonElement>('[aria-label="Close request"]')!.click();
      await fixture.whenStable();

      await clickButton(fixture, '▣ Console');
      expect(root().textContent).toContain('Logs from your request scripts appear here.');
      state.response.set({
        status: 200,
        statusText: 'OK',
        time: 1,
        size: 1,
        body: '',
        headers: [],
        assertions: [],
        logs: [{ level: 'log', values: ['hello', 'world'] }],
      });
      await fixture.whenStable();
      expect(root().textContent).toContain('[log] hello world');
      await clickButton(fixture, 'Close console');
      await clickButton(fixture, 'Manage variables');
      expect(state.section()).toBe('environments');
    });

    it('shows and dismisses errors', async () => {
      state.error.set('Something failed');
      await fixture.whenStable();
      expect(root().querySelector('[role="alert"]')?.textContent).toContain('Something failed');
      for (const dismiss of buttons(root(), 'Dismiss error')) dismiss.click();
      await fixture.whenStable();
      expect(state.error()).toBe('');
    });
  });
});
