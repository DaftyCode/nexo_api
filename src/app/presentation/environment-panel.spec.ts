import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton, exerciseControls } from '../testing/controls';
import { EnvironmentPanel } from './environment-panel';
import { WorkspaceState } from './workspace-state';

describe('EnvironmentPanel', () => {
  let component: EnvironmentPanel;
  let fixture: ComponentFixture<EnvironmentPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  const rows = () => component['rows']();

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [EnvironmentPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.confirm = () => true;
    await state.initialize();
    fixture = TestBed.createComponent(EnvironmentPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('creates, activates, duplicates, exports and deletes an environment', async () => {
    expect(root().textContent).toContain('Create your first environment.');
    const unchanged = await exerciseControls(fixture, () => [component['model'](), rows()]);
    expect(unchanged).toEqual([]);
    expect(root().textContent).toContain('Unsaved changes');

    const name = root().querySelector<HTMLInputElement>('label input')!;
    name.value = 'Staging';
    name.dispatchEvent(new Event('input'));
    await clickButton(fixture, 'Save environment');
    await settle();
    expect(state.environments().map((env) => env.name)).toEqual(['Staging']);
    expect(root().textContent).not.toContain('Unsaved changes');

    // The first environment saved becomes the active one.
    expect(root().textContent).toContain('This environment is active.');
    await clickButton(fixture, 'Deactivate');
    expect(state.environmentId()).toBe('');
    await clickButton(fixture, 'Use environment');
    expect(state.environmentId()).toBe(state.environments()[0].id);

    await clickButton(fixture, 'Duplicate');
    await settle();
    expect(
      state
        .environments()
        .map((env) => env.name)
        .sort(),
    ).toEqual(['Staging', 'Staging copy']);
    await clickButton(fixture, 'Export');
    expect(api.downloads.at(-1)?.name).toBe('Staging copy.environment.json');
    await clickButton(fixture, 'Delete');
    await settle();
    expect(state.environments().map((env) => env.name)).toEqual(['Staging']);

    await clickButton(fixture, 'Staging');
    expect(component['model']().name).toBe('Staging');
    await clickButton(fixture, 'New environment');
    expect(component['model']().id).toBe('');
  });

  it('edits and saves the global variables, masking secret values', async () => {
    await clickButton(fixture, 'Global variables');
    expect(root().textContent).toContain('Save globals');
    await clickButton(fixture, 'Add variable');
    const keys = root().querySelectorAll<HTMLInputElement>('[aria-label="Variable name"]');
    keys[0].value = 'token';
    keys[0].dispatchEvent(new Event('input'));
    const secret = root().querySelector<HTMLInputElement>('[aria-label="Mark as secret"]')!;
    secret.click();
    await fixture.whenStable();
    expect(rows()[0].secret).toBe(true);
    expect(root().querySelector('[aria-label="Show value"]')).not.toBeNull();
    await clickButton(fixture, 'Show value');
    await clickButton(fixture, 'Hide value');
    root().querySelectorAll<HTMLButtonElement>('[aria-label="Remove variable"]')[1].click();
    await fixture.whenStable();
    expect(rows()).toHaveLength(1);
    await clickButton(fixture, 'Save globals');
    await settle();
    expect(state.globalRows().map((row) => row.key)).toEqual(['token']);
  });

  it('shows values a script changed, and asks before saving over them', async () => {
    const value = (key: string) =>
      [...root().querySelectorAll<HTMLInputElement>('[aria-label="Variable name"]')]
        .find((input) => input.value === key)
        ?.closest('.kv-row')
        ?.querySelector<HTMLInputElement>('[aria-label="Variable value"]')?.value;
    const scriptWrites = async (values: { key: string; value: string }[]) => {
      const current = state.globalsDocument();
      state.documents.update((documents) => [
        ...documents.filter((d) => d.kind !== 'globals'),
        {
          id: current?.id ?? 'globals',
          workspace_id: 'local',
          kind: 'globals',
          name: 'Globals',
          revision: (current?.revision ?? 0) + 1,
          updated_at: 1,
          value: { values },
        },
      ]);
      await settle();
    };
    await clickButton(fixture, 'Global variables');
    // Without edits of its own, the editor follows the script.
    await scriptWrites([{ key: 'token', value: 'from-script' }]);
    expect(value('token')).toBe('from-script');
    expect(root().textContent).not.toContain('changed since you opened them');

    // With edits, it says so and asks before replacing the script's value.
    const keys = root().querySelectorAll<HTMLInputElement>('[aria-label="Variable name"]');
    keys[0].value = 'mine';
    keys[0].dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    await scriptWrites([{ key: 'token', value: 'second' }]);
    expect(root().textContent).toContain('changed since you opened them, for example by a script');
    state.confirm = () => false;
    await clickButton(fixture, 'Save globals');
    await settle();
    expect(value('token')).toBe('second');
    expect(state.globalRows().map((row) => row.key)).toEqual(['token']);

    keys[0].value = 'mine';
    keys[0].dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    await scriptWrites([{ key: 'token', value: 'third' }]);
    await clickButton(fixture, 'Show the latest');
    expect(value('token')).toBe('third');
    const again = root().querySelectorAll<HTMLInputElement>('[aria-label="Variable name"]');
    again[0].value = 'mine';
    again[0].dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    await scriptWrites([{ key: 'token', value: 'fourth' }]);
    state.confirm = () => true;
    await clickButton(fixture, 'Save globals');
    await settle();
    expect(state.globalRows().map((row) => row.key)).toEqual(['mine']);
    expect(root().textContent).not.toContain('Unsaved changes');
  });
});
