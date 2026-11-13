// Putting tabs and the side menu in the person's own order, and how Nexo opens.
import { TEST_API, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';
import { AppearanceState } from './appearance-state';

describe('Workspace order', () => {
  let fixture: ComponentFixture<Workspace>;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  /** A drag event; with no layout, `clientX`/`clientY` are fractions of the element. */
  const fire = (target: Element, type: string, at = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      clientX: at,
      clientY: at,
      dataTransfer: { setData: () => undefined, effectAllowed: '', dropEffect: '' },
    });
    target.dispatchEvent(event);
    return event;
  };
  const drag = async (from: Element, to: Element, at: number) => {
    fire(from, 'dragstart');
    fire(to, 'dragover', at);
    await fixture.whenStable();
    const hint = to.getAttribute('data-drop');
    fire(to, 'drop', at);
    await settle();
    return hint;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Workspace],
    }).compileComponents();
    fixture = TestBed.createComponent(Workspace);
    state = TestBed.inject(WorkspaceState);
    state.confirm = () => true;
    await fixture.whenStable();
    await state.initialize();
    await settle();
  });

  it('moves request tabs by dragging them and with Ctrl+Shift+PageUp/PageDown', async () => {
    state.newTab();
    state.newTab();
    await settle();
    const tabs = () => [...root().querySelectorAll<HTMLElement>('.request-tab')];
    const ids = () => state.tabs().map((tab) => tab.id);
    const [a, b, c] = ids();
    expect(await drag(tabs()[0], tabs()[2], 0.9)).toBe('after-x');
    expect(ids()).toEqual([b, c, a]);
    expect(await drag(tabs()[2], tabs()[0], 0.1)).toBe('before-x');
    expect(ids()).toEqual([a, b, c]);
    state.activeTabId.set(a);
    const key = (key: string) =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    key('PageDown');
    expect(ids()).toEqual([b, a, c]);
    key('PageUp');
    key('PageUp');
    expect(ids()).toEqual([a, b, c]);
  });

  it('moves the sections of the side menu by dragging them and with Alt+arrows', async () => {
    const appearance = TestBed.inject(AppearanceState);
    const sections = () =>
      [...root().querySelectorAll<HTMLElement>('.rail button')].map((b) => b.title);
    const button = (title: string) =>
      [...root().querySelectorAll<HTMLElement>('.rail button')].find((b) => b.title === title)!;
    expect(sections().slice(0, 3)).toEqual(['Collections', 'Environments', 'History']);
    expect(await drag(button('History'), button('Collections'), 0.1)).toBe('before-y');
    expect(sections().slice(0, 3)).toEqual(['History', 'Collections', 'Environments']);
    button('History').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    );
    await settle();
    expect(sections().slice(0, 3)).toEqual(['Collections', 'History', 'Environments']);
    expect(appearance.sectionsMoved()).toBe(true);

    // Settings → general: reset the order, and stop reopening tabs.
    state.section.set('settings');
    await settle();
    const reset = [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Reset the side menu order',
    )!;
    reset.click();
    await settle();
    expect(sections().slice(0, 3)).toEqual(['Collections', 'Environments', 'History']);
    const reopen = root().querySelector<HTMLInputElement>('app-session-settings input')!;
    expect(reopen.checked).toBe(true);
    reopen.checked = false;
    reopen.dispatchEvent(new Event('change'));
    expect(state.restoresTabs()).toBe(false);
  });

  it('saves the session of the workspace shortly after a change', async () => {
    const api = TestBed.inject(TEST_API);
    state.newTab();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const session = api.documentsStore.find((d) => d.kind === 'session');
    expect(session?.id).toBe('session-local');
    expect((session?.value as { tabs: unknown[] }).tabs).toHaveLength(2);
    // The session is not a resource of the workspace.
    await state.refresh();
    expect(state.documents().some((d) => d.kind === 'session')).toBe(false);
  });
});
