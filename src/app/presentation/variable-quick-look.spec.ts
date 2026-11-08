import { ComponentFixture, TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { VariableQuickLook } from './variable-quick-look';
import { WorkspaceState } from './workspace-state';

const stored = (id: string, kind: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind,
  name: id,
  revision: 1,
  updated_at: 1,
  value,
});

describe('VariableQuickLook', () => {
  let fixture: ComponentFixture<VariableQuickLook>;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const dialog = () => root().querySelector('[role="dialog"]');
  const toggle = async () => {
    root().querySelector<HTMLButtonElement>('button[aria-label="Variables quick look"]')!.click();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [VariableQuickLook],
    }).compileComponents();
    state = TestBed.inject(WorkspaceState);
    fixture = TestBed.createComponent(VariableQuickLook);
    await fixture.whenStable();
  });

  it('explains the empty scopes', async () => {
    await toggle();
    expect(dialog()?.textContent).toContain('Select or create an environment.');
    expect(dialog()?.textContent).toContain(
      'Open a saved request to see its collection variables.',
    );
    expect(dialog()?.textContent).toContain('No global variables yet.');
    await clickButton(fixture, 'Edit');
    expect(state.section()).toBe('environments');
    expect(dialog()).toBeNull();
  });

  it('shows every scope, hides secrets until asked and edits each one', async () => {
    state.documents.set([
      stored('dev', 'environment', {
        values: [
          { key: 'host', value: 'dev.example.com' },
          { key: 'token', value: 'abc', type: 'secret' },
        ],
      }),
      stored('shop', 'collection', {
        info: { name: 'shop' },
        item: [{ name: 'List', request: { url: 'x' } }],
        variable: [{ key: 'page', value: '1', disabled: true }],
      }),
      stored('globals', 'globals', { values: [{ key: 'tenant', value: 'acme' }] }),
    ]);
    const environments = root().querySelector<HTMLSelectElement>('#active-environment')!;
    await fixture.whenStable();
    environments.value = 'dev';
    environments.dispatchEvent(new Event('change'));
    state.newTab(undefined, 'shop', [0]);
    await toggle();
    const text = () => dialog()?.textContent ?? '';
    for (const value of ['dev.example.com', '••••••••', 'page', 'tenant', 'acme'])
      expect(text()).toContain(value);
    expect(text()).not.toContain('abc');
    await clickButton(fixture, 'Show secrets');
    expect(text()).toContain('abc');
    await clickButton(fixture, 'Hide secrets');

    buttons(dialog()!, 'Edit')[1].click();
    await fixture.whenStable();
    expect(state.section()).toBe('collection-settings');
    expect(state.settingsCollectionId()).toBe('shop');
  });

  it('closes when clicking elsewhere or pressing Escape', async () => {
    await toggle();
    root().querySelector<HTMLElement>('[role="dialog"]')!.click();
    await fixture.whenStable();
    expect(dialog()).not.toBeNull();
    document.body.click();
    await fixture.whenStable();
    expect(dialog()).toBeNull();
    await toggle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(dialog()).toBeNull();
  });
});
