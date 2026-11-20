import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, control, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('MaskingSets', () => {
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
  const save = () => buttons(root(), /^Save$/)[0];
  const selects = () => [...root().querySelectorAll<HTMLSelectElement>('.mask-rule select')];
  const paths = () => [...root().querySelectorAll<HTMLInputElement>('.mask-rule input')];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mask.apply': (payload: Record<string, unknown>) => ({
          documents: (payload['documents'] as Record<string, unknown>[]).map((document) => ({
            ...document,
            email: '****',
          })),
        }),
      }),
      imports: [IntegrationPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(IntegrationPanel);
    await settle();
    await click(/^Masking$/);
  });

  it('creates a set of rules, tries it on an example and saves it', async () => {
    expect(text()).toContain('No masking sets yet.');
    await click('New masking set');
    expect(text()).toContain('Name the masking set');
    expect(save().disabled).toBe(true);
    await fill(fixture, 'Name', 'Customers');
    expect(text()).toContain('Add a rule with the path of a field');
    await fill(fixture, 'Field path', 'email');
    // A second rule truncates the card, and a third one is removed again.
    await click('Add rule');
    await click('Add rule');
    paths()[1].value = 'card.number';
    paths()[1].dispatchEvent(new Event('input'));
    selects()[1].value = 'truncate';
    selects()[1].dispatchEvent(new Event('input'));
    selects()[1].dispatchEvent(new Event('change'));
    await settle();
    expect(text()).toContain('Characters kept');
    buttons(root(), 'Remove rule').at(-1)!.click();
    await settle();
    expect(selects()).toHaveLength(2);
    (control(root(), 'Mask what MCP agents read too') as HTMLInputElement).click();
    await settle();

    await click(/^Try$/);
    const tried = api.calls.find((call) => call.operation === 'mask.apply')!.payload;
    expect(tried['rules']).toEqual([
      { path: 'email', method: 'hide' },
      { path: 'card.number', method: 'truncate', keep: 4 },
    ]);
    expect(root().querySelector('.mask-result')?.textContent).toContain('"email": "****"');
    await fill(fixture, 'Example (JSON)', '{');
    await click(/^Try$/);
    expect(text()).toContain('The example must be valid JSON');

    await click(/^Save$/);
    const [saved] = api.documentsStore;
    expect(saved).toMatchObject({
      kind: 'masking',
      name: 'Customers',
      value: {
        agents: true,
        rules: [
          { path: 'email', method: 'hide' },
          { path: 'card.number', method: 'truncate', keep: 4 },
        ],
      },
    });
    expect(state.toast()).toMatchObject({
      title: 'Masking set saved',
      params: { v0: 'Customers' },
    });
    expect(text()).toContain('2 rules');
    expect(text()).toContain('Agents');
  });

  it('edits and deletes a saved set, and closes the form when cancelled', async () => {
    await state.applySaved([
      await api.save({
        id: 'm1',
        workspace_id: 'local',
        kind: 'masking',
        name: 'PII',
        revision: 0,
        updated_at: 0,
        value: { rules: [{ path: 'email', method: 'hash' }] },
      }),
    ]);
    await settle();
    await click(/^Edit$/);
    expect(paths()[0].value).toBe('email');
    expect(selects()[0].value).toBe('hash');
    await fill(fixture, 'Name', 'People');
    await click(/^Save$/);
    expect(api.documentsStore[0]).toMatchObject({ id: 'm1', name: 'People', revision: 2 });
    await click(/^Edit$/);
    await click(/^Cancel$/);
    expect(buttons(root(), /^Save$/)).toEqual([]);

    vi.spyOn(state, 'confirm').mockReturnValue(false);
    await click(/^Delete$/);
    expect(api.documentsStore).toHaveLength(1);
    vi.spyOn(state, 'confirm').mockReturnValue(true);
    await click(/^Delete$/);
    expect(api.documentsStore).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'Masking set deleted' });
    expect(text()).toContain('No masking sets yet.');
  });
});
