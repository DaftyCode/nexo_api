// Importing, workspaces, keyboard shortcuts, request tabs and errors of the workspace.
import { TEST_API, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, fill } from '../testing/controls';
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

    beforeEach(async () => {
      state = TestBed.inject(WorkspaceState);
      state.confirm = () => true;
      await state.initialize();
      await settle();
    });

    it('imports pasted content and files, and creates workspaces', async () => {
      const api = TestBed.inject(TEST_API);
      api.responses['import'] = ({ content }: Record<string, unknown>) => ({
        kind: 'collection',
        name: String(content),
        value: { info: { name: String(content) }, item: [] },
      });
      await clickButton(fixture, 'Import');
      await fill(fixture, 'Import content', 'Pasted', dialog()!);
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
      state.tabsStore.setResponse(state.activeTabId(), {
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
