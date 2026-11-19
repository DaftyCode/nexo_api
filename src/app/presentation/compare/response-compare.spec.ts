import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ExecutionResponse, WorkspaceDocument, newRequest } from '../../domain/models';
import { ResponseComparison } from '../../domain/response-compare';
import { buttons, clickButton, control, fill, renderDeferred } from '../../testing/controls';
import { TEST_API, TestApi, testProviders } from '../../testing/providers';
import { WorkspaceState } from '../workspace-state';
import { CompareStore } from './compare-store';
import { ResponseCompare } from './response-compare';

const response = (body: string, extra: Partial<ExecutionResponse> = {}): ExecutionResponse => ({
  status: 200,
  statusText: 'OK',
  headers: [{ key: 'Date', value: 'Tue', enabled: true }],
  body,
  time: 3,
  size: body.length,
  assertions: [],
  logs: [],
  ...extra,
});
const doc = (
  id: string,
  kind: string,
  name: string,
  value: unknown,
  at = 1,
): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind,
  name,
  revision: 1,
  updated_at: at,
  value,
});
const changed: ResponseComparison = {
  same: false,
  status: {
    same: false,
    source: { status: 200, statusText: 'OK' },
    target: { status: 0, statusText: '', error: 'Connection refused' },
  },
  headers: [{ name: 'Date', source: 'Tue', target: 'Wed' }],
  body: {
    format: 'json',
    same: false,
    cut: true,
    complete: false,
    differences: [
      { path: '$.name', source: 'Ana', target: 'Eva' },
      { path: '$.tags[1]', target: 'b' },
    ],
    source: '{\n  "name": "Ana"\n}',
    target: '{\n  "name": "Eva",\n  "tags": ["a", "b"]\n}',
  },
};

describe('ResponseCompare', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<ResponseCompare>;
  let api: TestApi;
  let state: WorkspaceState;
  let store: CompareStore;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent?.replace(/\s+/g, ' ') ?? '';
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const compares = () => api.calls.filter((call) => call.operation === 'response.compare');

  async function open(documents: WorkspaceDocument[], answer: unknown = changed) {
    await TestBed.configureTestingModule({
      providers: testProviders({ 'response.compare': answer, request: response('{"sent":1}') }),
      imports: [ResponseCompare],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    api.documentsStore.push(...documents);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.documents.set([...documents]);
    store = TestBed.inject(CompareStore);
    fixture = TestBed.createComponent(ResponseCompare);
    await settle();
  }

  afterEach(() => vi.restoreAllMocks());

  it('compares the last two responses of the history and shows what changed', async () => {
    const older = response('{"name":"Ana"}');
    await open([
      doc('h1', 'history', 'GET https://api.test/users', { response: older }, 1),
      doc('h2', 'history', 'GET https://api.test/users', { response: response('{}') }, 2),
    ]);
    store.openHistory();
    expect(state.section()).toBe('compare');
    await settle();
    await clickButton(fixture, /^Compare$/);
    await settle();
    const [call] = compares();
    expect(call.payload['source']).toEqual({
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'Date', value: 'Tue' }],
      body: '{"name":"Ana"}',
    });
    expect(call.payload['ignore']).toBeUndefined();
    expect(text()).toContain('What changed');
    expect(text()).toContain('200 OK→ERR');
    expect(text()).toContain('Connection refused');
    expect(text()).toContain('1 differ');
    expect(text()).toContain('2 fields differ');
    expect(text()).toContain('only the part kept is compared');
    expect(text()).toContain('Showing the first 1000 differences.');
    const rows = (label: string) =>
      [...root().querySelectorAll(`table[aria-label="${label}"] tbody tr`)].map((row) =>
        [...row.children].map((cell) => cell.textContent?.trim()),
      );
    expect(rows('Headers that differ')).toEqual([['Date', 'Changed', 'Tue', 'Wed']]);
    expect(rows('Fields that differ')).toEqual([
      ['$.name', 'Changed', 'Ana', 'Eva'],
      ['$.tags[1]', 'Added', '—', 'b'],
    ]);
    // Both bodies side by side, under the names of the responses.
    for (let i = 0; i < 30 && !root().querySelector('app-diff-view .cm-mergeView'); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(root().querySelectorAll('app-diff-view .cm-editor')).toHaveLength(2);
    expect(text()).toContain('GET https://api.test/users');

    // Leaving out a field compares the same responses again, without reading them again.
    const reads = api.calls.length;
    await fill(fixture, 'Fields to leave out', 'updatedAt, $.meta.id');
    await fill(fixture, 'Headers to leave out', 'Date');
    await settle();
    const last = compares().at(-1)!;
    expect(last.payload['ignore']).toEqual(['updatedAt', '$.meta.id']);
    expect(last.payload['ignoreHeaders']).toEqual(['Date']);
    expect(api.calls.length - reads).toBe(2);
    // Enter compares again too, and only when what is left out changed.
    const input = control(root(), 'Fields to leave out') as HTMLInputElement;
    input.value = 'name';
    input.dispatchEvent(new Event('input'));
    const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    enter();
    await settle();
    enter();
    await settle();
    expect(compares()).toHaveLength(4);
    expect(compares().at(-1)!.payload['ignore']).toEqual(['name']);
  });

  it('sends the request of the tab with two environments, asking where one asks first', async () => {
    await open(
      [
        doc('stage', 'environment', 'Staging', {
          values: [{ key: 'host', value: 'stage', enabled: true }],
          protection: 'confirm',
        }),
        doc('prod', 'environment', 'Production', { values: [] }),
      ],
      { ...changed, same: true, headers: [], status: { ...changed.status, same: true } },
    );
    const request = { ...newRequest('r'), name: 'Create user', method: 'POST', url: '{{host}}/u' };
    state.tabsStore.open(request);
    store.open({ kind: 'send', environment: 'stage' }, { kind: 'send', environment: 'prod' });
    await settle();
    expect(text()).toContain('Compare sends Create user, the request of the active tab.');
    const confirm = vi.spyOn(state, 'confirm').mockReturnValue(false);
    await clickButton(fixture, /^Compare$/);
    await settle();
    expect(confirm).toHaveBeenCalledWith('environment.confirmSend', {
      v0: 'Staging',
      v1: 'POST',
      v2: '{{host}}/u',
    });
    expect(api.calls.some((call) => call.operation === 'request')).toBe(false);

    confirm.mockReturnValue(true);
    await clickButton(fixture, /^Compare$/);
    await settle();
    const sent = api.calls.filter((call) => call.operation === 'request');
    expect(sent.map((call) => call.payload['environment'])).toEqual(['stage', 'prod']);
    expect(sent[0].payload['variables']).toEqual([{ key: 'host', value: 'stage', enabled: true }]);
    // Each response goes to the history, as any request sent.
    expect(state.history()).toHaveLength(2);
    expect(compares()).toHaveLength(1);
    expect(text()).toContain('Create user with Staging');
    expect(text()).toContain('Create user with Production');
  });

  it('compares the responses of a run and of the tabs, and swaps them', async () => {
    const results = [
      { ...response('{"a":1}'), name: 'Users', iteration: 0 },
      { ...response('{"a":2}'), name: 'Users', iteration: 1 },
    ];
    await open([doc('run1', 'run', 'Collection run', null)], {
      ...changed,
      same: true,
      headers: [],
      status: { ...changed.status, same: true },
      body: { format: 'text', same: true, cut: false, source: 'x', target: 'x' },
    });
    api.documentsStore[0] = { ...api.documentsStore[0], value: { results } };
    store.openRun();
    await settle();
    expect(text()).toContain('Users · iteration 2 · 200');
    await clickButton(fixture, /^Compare$/);
    await settle();
    expect(compares()[0].payload['target']).toMatchObject({ body: '{"a":2}' });
    expect(text()).toContain('The responses are the same');
    expect(root().querySelector('app-diff-view')).toBeNull();

    await clickButton(fixture, 'Swap the responses');
    await settle();
    expect(compares()[1].payload['source']).toMatchObject({ body: '{"a":2}' });
    expect(store.model().source.result).toBe('1');

    // A tab with a response, chosen by name.
    const tab = state.tabsStore.open({ ...newRequest('t'), name: 'Health' });
    state.tabsStore.setResponse(tab, response('ok'));
    store.open({ kind: 'tab', tab });
    await settle();
    expect(text()).toContain('Health');
    await clickButton(fixture, /^Compare$/);
    await settle();
    expect(compares().at(-1)!.payload['source']).toMatchObject({ body: 'ok' });
  });

  it('says what is missing to compare, and why a body cannot be shown', async () => {
    await open([doc('h1', 'history', 'GET /a', { request: {} })], {
      ...changed,
      body: { format: 'binary', same: false, cut: false },
    });
    store.open({ kind: 'tab', tab: '' }, { kind: 'history', id: 'h1' });
    await settle();
    await clickButton(fixture, /^Compare$/);
    await settle();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      'Choose a tab with a response',
    );
    await clickButton(fixture, 'Dismiss error');
    expect(root().querySelector('[role="alert"]')).toBeNull();

    for (const [source, message] of [
      [{ kind: 'history', id: 'h1' }, 'This history entry has no response'],
      [{ kind: 'history', id: 'gone' }, 'Choose a response of the history'],
      [{ kind: 'run', id: 'gone', index: 0 }, 'Choose a collection run'],
      [{ kind: 'send', environment: '' }, 'Open the request to send in a tab'],
    ] as const) {
      store.open(source);
      await clickButton(fixture, /^Compare$/);
      await settle();
      expect(store.error()).toBe(message);
    }
    state.tabsStore.open({ ...newRequest('w'), protocol: 'websocket' });
    await store.compare();
    expect(store.error()).toBe('Only HTTP and GraphQL requests are sent to compare');

    // A binary body is only said to differ.
    const tab = state.tabsStore.open(newRequest('b'));
    state.tabsStore.setResponse(tab, response('iVBO', { bodyEncoding: 'base64' }));
    store.open({ kind: 'tab', tab }, { kind: 'tab', tab });
    await clickButton(fixture, /^Compare$/);
    await settle();
    expect(text()).toContain('Binary bodies that differ');
    expect(root().querySelector('app-diff-view')).toBeNull();
    expect(buttons(root(), 'Compare').length).toBeGreaterThan(0);
  });

  it('forgets the comparison when another workspace opens', async () => {
    await open([]);
    store.open({ kind: 'history', id: 'h1' });
    state.workspaceId.set('other');
    await settle();
    expect(store.model().source.kind).toBe('send');
    expect(store.compared()).toBeUndefined();
  });
});
