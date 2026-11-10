import { ComponentFixture, TestBed } from '@angular/core/testing';
import { diagnosticCount } from '@codemirror/lint';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import {
  buttons,
  clickButton,
  codeEditor,
  codeView,
  renderDeferred,
  typeCode,
} from '../testing/controls';
import { ApiDiff, ApiInspection } from '../domain/api-definitions';
import { WorkspaceDocument } from '../domain/models';
import { ApiDefinitions } from './api-definitions';
import { WorkspaceState } from './workspace-state';

const source = 'openapi: 3.0.0\ninfo:\n  title: Shop\npaths:\n  /orders:\n    get: {}\n';
const inspection: ApiInspection = {
  version: '3.0',
  findings: [
    { severity: 'error', rule: 'info-version', params: [], pointer: '/info', line: 2 },
    {
      severity: 'warning',
      rule: 'operation-summary',
      params: ['GET /orders'],
      pointer: '/paths/~1orders/get',
      line: 6,
    },
    { severity: 'info', rule: 'ref-external', params: ['other.yaml'], pointer: '/x' },
  ],
  outline: {
    title: 'Shop',
    version: '',
    paths: [
      {
        path: '/orders',
        pointer: '/paths/~1orders',
        line: 5,
        operations: [
          {
            method: 'get',
            operationId: 'listOrders',
            summary: '',
            deprecated: true,
            pointer: '/paths/~1orders/get',
            line: 6,
            parameters: [
              {
                name: 'status',
                in: 'query',
                required: true,
                type: 'string',
                pointer: '/p',
                line: 4,
              },
            ],
            requestBody: {
              required: true,
              media: ['application/json'],
              schema: 'Order',
              pointer: '/b',
              line: 3,
            },
            responses: [
              { status: '200', description: 'OK', schema: 'Order[]', pointer: '/r', line: 6 },
            ],
          },
        ],
      },
      {
        path: '/users',
        pointer: '/paths/~1users',
        operations: [
          {
            method: 'post',
            operationId: '',
            summary: 'Add a user',
            deprecated: false,
            pointer: '/u',
            parameters: [],
            requestBody: null,
            responses: [],
          },
        ],
      },
    ],
    schemas: [{ name: 'Order', type: 'object', pointer: '/components/schemas/Order', line: 1 }],
  },
};
const diff: ApiDiff = {
  breaking: 2,
  removed: [{ method: 'delete', path: '/orders/{id}', pointer: '/d', line: 9 }],
  added: [{ method: 'put', path: '/orders/{id}', pointer: '/a', line: 3 }],
  changed: [
    {
      method: 'get',
      path: '/orders',
      pointer: '/g',
      line: 5,
      changes: [
        {
          rule: 'parameter-added-required',
          params: ['query', 'customer'],
          breaking: true,
          pointer: '/c',
          side: 'source',
          line: 4,
        },
        {
          rule: 'response-removed',
          params: ['404'],
          breaking: false,
          pointer: '/o',
          side: 'base',
          line: 7,
        },
      ],
    },
  ],
};

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
    expect(root().textContent).toContain('A name is required');

    await type(root().querySelector('input') as HTMLInputElement, 'Shop API');
    await typeSource(source);
    await clickButton(fixture, 'Save definition');
    await settle();
    expect(api.documentsStore).toEqual([
      expect.objectContaining({ kind: 'api', name: 'Shop API', value: { source } }),
    ]);
    expect(calls('api.inspect').at(-1)).toEqual({ workspace: 'local', source });
    expect(state.notice()).toBe('Definition saved');
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
