import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, control, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('ConnectionTypesSettings', () => {
  let fixture: ComponentFixture<IntegrationPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };
  const own = () => api.documentsStore.filter((document) => document.kind === 'connection-type');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [IntegrationPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(IntegrationPanel);
    await settle();
    await click(/^Connection types$/);
  });

  it('lists the built-in types, and creates, edits and deletes your own', async () => {
    expect(text()).toContain('Development');
    expect(text()).toContain('Commits by hand. Confirms each change.');
    await click('+ New connection type');
    expect((buttons(root(), /^Save$/)[0] as HTMLButtonElement).disabled).toBe(true);
    await fill(fixture, 'Name', 'Staging');
    (control(root(), 'Confirm changes of structure') as HTMLInputElement).click();
    await click('Color 2');
    await click(/^Save$/);
    expect(own()[0]).toMatchObject({ name: 'Staging', value: { confirmStructure: true } });
    expect(text()).toContain('Confirms changes of structure.');
    await click(/^Edit$/);
    await fill(fixture, 'Name', 'Staging 2');
    await click(/^Save$/);
    expect(text()).toContain('Staging 2');
    state.confirm = () => true;
    await click(/^Delete$/);
    expect(own()).toHaveLength(0);
  });

  it('keeps a type that connections have', async () => {
    state.applySaved([
      {
        id: 'staging',
        workspace_id: 'local',
        kind: 'connection-type',
        name: 'Staging',
        revision: 1,
        updated_at: 0,
        value: { readOnly: true },
      },
      {
        id: 'c1',
        workspace_id: 'local',
        kind: 'connection',
        name: 'Shop',
        revision: 1,
        updated_at: 0,
        value: { driver: 'postgres', type: 'staging' },
      },
    ]);
    await settle();
    expect(text()).toContain('Read-only.');
    await click(/^Delete$/);
    expect(text()).toContain('A connection has this type: give it another one first');
  });
});
