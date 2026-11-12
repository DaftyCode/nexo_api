import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiDefinitions } from './api-definitions';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { WorkspaceState } from './workspace-state';
import {
  buttons,
  clickButton,
  codeEditor,
  codeView,
  renderDeferred,
  typeCode,
} from '../testing/controls';
import { diff, inspection, source } from '../testing/api-definitions';
import { WorkspaceDocument } from '../domain/models';

describe('ApiDefinitions', () => {
  let fixture: ComponentFixture<ApiDefinitions>;

  let api: TestApi;

  let state: WorkspaceState;

  const root = () => fixture.nativeElement as HTMLElement;

  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };

  // The definition's code editor: its text, its selection and typing in it.
  const view = () => codeView(codeEditor(root(), 'OpenAPI definition'));

  const written = () => view().state.doc.toString();

  const selection = () => view().state.selection.main;

  const selectedLine = () => view().state.doc.lineAt(selection().from).number;

  const typeSource = async (value: string) => {
    typeCode(codeEditor(root(), 'OpenAPI definition'), value);
    await fixture.whenStable();
  };

  const type = async (control: HTMLInputElement, value: string) => {
    control.value = value;
    control.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };

  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await settle();
  };

  const calls = (operation: string) =>
    api.calls.filter((call) => call.operation === operation).map((call) => call.payload);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ApiDefinitions],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.responses['api.inspect'] = inspection;
    api.responses['api.diff'] = diff;
    fixture = TestBed.createComponent(ApiDefinitions);
    await settle();
    await renderDeferred(fixture);
  });

  it('explores paths, operations and schemas, with search', async () => {
    await clickButton(fixture, 'Explorer');
    expect(root().textContent).toContain('Check the definition to explore it.');
    await typeSource(source);
    await clickButton(fixture, 'Check definition');
    await settle();
    expect(calls('api.inspect')).toHaveLength(1);
    for (const text of [
      '/orders',
      'GET',
      'listOrders',
      'status *',
      'query · string',
      'Order *',
      'Order[]',
      'Add a user',
      'Order',
    ])
      expect(root().textContent).toContain(text);
    expect(root().querySelector('.deprecated')).not.toBeNull();
    buttons(root(), /status \*/)[0].click();
    expect(selectedLine()).toBe(4);
    await clickButton(fixture, 'Go to definition');
    expect(selectedLine()).toBe(6);

    const search = root().querySelector('input[type="search"]') as HTMLInputElement;
    await type(search, 'users');
    const tree = () => root().querySelector('.api-tree')!.textContent;
    expect(tree()).toContain('/users');
    expect(tree()).not.toContain('/orders');
    expect(root().textContent).not.toContain('Schemas');
    await type(search, 'nothing');
    expect(root().textContent).toContain('No paths match.');
  });

  it('compares versions and marks the breaking changes', async () => {
    await clickButton(fixture, 'Changes');
    await clickButton(fixture, 'Compare');
    await settle();
    expect(root().textContent).toContain('Save the definition first');

    const saved: WorkspaceDocument = {
      id: 'api1',
      workspace_id: 'local',
      kind: 'api',
      name: 'Shop API',
      revision: 2,
      updated_at: 0,
      value: { source: 'saved: true' },
    };
    api.documentsStore.push(saved);
    api.revisions = async () => [
      {
        revision: 1,
        changed_at: Date.UTC(2026, 0, 1),
        value: { ...saved, value: { source: 'first: true' } },
      },
    ];
    await state.refresh();
    await settle();
    await choose(root().querySelector('select') as HTMLSelectElement, 'api1');
    expect(written()).toBe('saved: true');
    const [base, target] = [...root().querySelectorAll('select')].slice(1) as HTMLSelectElement[];
    expect([...base.options].map((o) => o.value)).toEqual(['saved', 'r:1']);
    await choose(base, 'r:1');
    await typeSource(source);
    await clickButton(fixture, 'Compare');
    await settle();
    expect(calls('api.diff').at(-1)).toEqual({ workspace: 'local', base: 'first: true', source });
    for (const text of [
      '2 breaking changes',
      'Endpoint removed',
      'Endpoint added',
      'New required query parameter customer',
      'Response 404 was removed',
      'Breaking',
    ])
      expect(root().textContent).toContain(text);
    // Lines of the later version are the editor's; those of the earlier one are not.
    expect(buttons(root(), 'Line').map((b) => b.textContent?.trim())).toEqual(['Line 3', 'Line 4']);
    await clickButton(fixture, 'Line 4');
    expect(selectedLine()).toBe(4);

    await choose(target, 'saved');
    api.responses['api.diff'] = { breaking: 0, added: [], removed: [], changed: [] };
    await clickButton(fixture, 'Compare');
    await settle();
    expect(calls('api.diff').at(-1)).toMatchObject({ base: 'first: true', source: 'saved: true' });
    expect(root().textContent).toContain('No breaking changes.');
    expect(root().textContent).toContain('The endpoints did not change.');
    expect(buttons(root(), 'Line')).toHaveLength(0);

    // A revision that is no longer in the list cannot be compared.
    api.revisions = async () => [];
    await choose(root().querySelector('select') as HTMLSelectElement, '');
    await choose(root().querySelector('select') as HTMLSelectElement, 'api1');
    expect(written()).toBe('saved: true');
    const [, later] = [...root().querySelectorAll('select')].slice(1) as HTMLSelectElement[];
    expect([...later.options].map((o) => o.value)).toEqual(['editing', 'saved']);
  });
});
