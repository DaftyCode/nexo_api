import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { clickButton } from '../testing/controls';
import { ExecutionResponse, newRequest } from '../domain/models';
import { SCHEMA_TEST_NAME } from '../domain/schema-test';
import { WorkspaceState } from './workspace-state';
import { ResponseSchema } from './response-schema';
import { ResponseView } from './response-view';

const response = (body: string): ExecutionResponse =>
  ({
    status: 200,
    statusText: 'OK',
    headers: [],
    body,
    time: 1,
    size: 1,
  }) as unknown as ExecutionResponse;

describe('ResponseSchema', () => {
  let fixture: ComponentFixture<ResponseSchema>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ResponseSchema],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.newTab({ ...newRequest('r1'), url: 'https://api.test/users', tests: "pm.test('mine');" });
    fixture = TestBed.createComponent(ResponseSchema);
    fixture.componentRef.setInput('response', response('{"id":1}'));
    await fixture.whenStable();
  });

  it('infers the schema with the history of the request and adds it as a test', async () => {
    await api.save({
      id: 'h1',
      workspace_id: 'local',
      kind: 'history',
      name: 'GET https://api.test/users',
      revision: 0,
      updated_at: 1,
      value: { request: {}, response: response('{"id":2,"name":"Ana"}') },
    });
    await state.refresh();
    api.responses['schema.infer'] = ({ samples }: Record<string, unknown>) => ({
      schema: { type: 'object', required: ['id'] },
      sampled: (samples as unknown[]).length,
    });
    await clickButton(fixture, 'JSON Schema…');
    root().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await fixture.whenStable();
    await clickButton(fixture, 'Infer schema');
    await settle();
    expect(api.calls.find((call) => call.operation === 'schema.infer')?.payload).toEqual({
      workspace: 'local',
      samples: [{ id: 1 }, { id: 2, name: 'Ana' }],
      enums: true,
    });
    expect(root().textContent).toContain('Read from 2 responses');
    expect(root().querySelector('pre')?.textContent).toContain('"required": [');

    await clickButton(fixture, 'Add schema test');
    await settle();
    const tests = state.active()!.request.tests;
    expect(tests.startsWith("pm.test('mine');\n\n// Nexo: JSON Schema test")).toBe(true);
    expect(tests).toContain(SCHEMA_TEST_NAME);
    expect(state.active()!.dirty).toBe(true);
    expect(state.toast()).toMatchObject({ kind: 'success', title: 'Schema test added' });

    await clickButton(fixture, 'Download schema');
    await settle();
    expect(api.downloads.at(-1)?.name).toBe('response.schema.json');
    await clickButton(fixture, 'Close');
    expect(root().querySelector('pre')).toBeNull();
    expect(root().textContent).toContain('JSON Schema…');
  });

  it('says why a schema could not be inferred or added', async () => {
    fixture.componentRef.setInput('response', response('not json'));
    await clickButton(fixture, 'JSON Schema…');
    await clickButton(fixture, 'Infer schema');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The schema could not be inferred',
      detail: 'This response is not complete JSON',
    });
    fixture.componentRef.setInput('response', response('{}'));
    api.responses['schema.infer'] = { schema: {}, sampled: 1 };
    await clickButton(fixture, 'Infer schema');
    await settle();
    for (const tab of [...state.tabs()]) state.tabsStore.close(tab.id);
    await clickButton(fixture, 'Add schema test');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The schema test could not be added',
    });
  });
});

describe('ResponseView and JSON Schema', () => {
  it('offers the schema of complete JSON bodies only', async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ResponseView],
    }).compileComponents();
    const fixture = TestBed.createComponent(ResponseView);
    const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
    fixture.componentRef.setInput('response', response('{"a":1}'));
    await fixture.whenStable();
    expect(text()).toContain('JSON Schema…');
    fixture.componentRef.setInput('response', response('plain'));
    await fixture.whenStable();
    expect(text()).not.toContain('JSON Schema…');
  });
});
