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
import { diagnosticCount } from '@codemirror/lint';

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

  const selected = () => written().slice(selection().from, selection().to);

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

  it('saves a new definition, shows its problems and goes to their lines', async () => {
    expect(root().textContent).toContain('Check the definition to see its problems.');
    await type(root().querySelector('input') as HTMLInputElement, ' ');
    await clickButton(fixture, 'Save definition');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The definition could not be saved',
      detail: 'A name is required',
    });

    await type(root().querySelector('input') as HTMLInputElement, 'Shop API');
    await typeSource(source);
    await clickButton(fixture, 'Save definition');
    await settle();
    expect(api.documentsStore).toEqual([
      expect.objectContaining({ kind: 'api', name: 'Shop API', value: { source } }),
    ]);
    expect(calls('api.inspect').at(-1)).toEqual({ workspace: 'local', source });
    expect(state.notice()).toBe('Definition saved');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Definition saved',
      params: { v0: 'Shop API' },
    });
    for (const text of [
      'OpenAPI 3.0',
      '1 errors, 1 warnings, 1 notes',
      'info.version is missing',
      'GET /orders has no summary or description',
      'The external reference other.yaml is not checked',
    ])
      expect(root().textContent).toContain(text);
    expect(buttons(root(), 'Line')).toHaveLength(2);
    // The findings with a line are marked in the editor too.
    expect(diagnosticCount(view().state)).toBe(2);
    await clickButton(fixture, 'Line 6');
    expect(selectedLine()).toBe(6);
    expect(selected()).toBe('    get: {}');

    // Saving again is a new revision of the same definition.
    await typeSource(`${source}# more\n`);
    expect(root().textContent).toContain('The definition changed since it was checked.');
    expect(diagnosticCount(view().state)).toBe(0);
    await clickButton(fixture, 'Save definition');
    await settle();
    expect(api.documentsStore).toHaveLength(1);
    expect(api.documentsStore[0].revision).toBe(2);
    expect(root().textContent).not.toContain('The definition changed since it was checked.');

    api.responses['import'] = { documents: [] };
    await clickButton(fixture, 'Generate collection');
    await settle();
    expect(calls('import').at(-1)).toMatchObject({ content: `${source}# more\n` });
  });

  it('shows why a definition cannot be read, and keeps working without revisions', async () => {
    api.responses['api.inspect'] = {
      version: '',
      findings: [
        { severity: 'error', rule: 'parse', params: ['bad indentation'], pointer: '', line: 3 },
      ],
      outline: null,
    };
    api.revisions = async () => {
      throw new Error('offline');
    };
    api.documentsStore.push({
      id: 'api1',
      workspace_id: 'local',
      kind: 'api',
      name: 'Broken',
      revision: 1,
      updated_at: 0,
      value: { source: 'a: [' },
    });
    await state.refresh();
    await settle();
    await choose(root().querySelector('select') as HTMLSelectElement, 'api1');
    await clickButton(fixture, 'Check definition');
    await settle();
    expect(root().textContent).toContain('The definition cannot be read: bad indentation');
    expect(root().textContent).not.toMatch(/OpenAPI \d/);
    api.responses['api.inspect'] = { version: '2.0', findings: [], outline: null };
    await clickButton(fixture, 'Check definition');
    await settle();
    expect(root().textContent).toContain('Swagger 2.0');
    expect(root().textContent).toContain('No problems found.');
  });
});
