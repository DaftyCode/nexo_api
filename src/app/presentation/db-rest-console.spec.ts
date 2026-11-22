import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { DbSection } from './db-panel/section';
import { CodeEditor } from './code-editor';
import { WorkspaceState } from './workspace-state';

const module = {
  id: 'elastic',
  name: 'Elasticsearch and OpenSearch',
  description: '',
  version: '0.10.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Search',
  revision: 1,
  updated_at: 0,
  value: { driver: 'elastic', host: 'es', port: 9200, user: 'elastic' },
};

function request(payload: Record<string, unknown>) {
  const path = String(payload['path']);
  if (path.startsWith('_cat/indices?format=json'))
    return { status: 200, body: [{ index: 'shop' }], elapsedMs: 1 };
  if (payload['method'] === 'DELETE' && payload['confirmName'] !== 'shop')
    throw new Error('Type shop to confirm it');
  if (path === '_search')
    return {
      status: 200,
      body: { hits: { hits: [{ _id: '1', _source: { name: 'Lamp', user: { city: 'Lima' } } }] } },
      elapsedMs: 3,
    };
  return { status: path === 'missing' ? 404 : 200, body: { status: 'green' }, elapsedMs: 2 };
}

describe('the console of Query DSL', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => setTimeout(done));
    }
  };
  const calls = () =>
    api.calls.filter((call) => call.operation === 'db.rest.request').map((call) => call.payload);
  const editor = () =>
    fixture.debugElement.query((node) => node.componentInstance instanceof CodeEditor)
      .componentInstance as CodeEditor;
  /** Writes the requests and puts the cursor at `at` (a text the cursor goes to). */
  const write = async (text: string, at: string) => {
    const view = editor().editor()!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    view.dispatch({ selection: { anchor: text.indexOf(at) } });
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '8.17.4', tls: false }),
        'db.dialect': () => ({
          driver: { id: 'elastic', name: 'Elasticsearch and OpenSearch', version: '1' },
          capabilities: { extensions: ['rest'] },
          dialect: { name: 'elasticsearch', quoteOpen: '"', quoteClose: '"' },
        }),
        'db.tree': () => ({ nodes: [] }),
        'db.rest.request': request,
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(connection);
    await state.refresh();
    state.databaseSession.set({
      expanded: [],
      active: 'c1',
      bookmarks: [],
      simple: true,
      tabs: [{ id: 'r1', kind: 'rest', connection: 'c1', title: 'Query DSL' }],
      activeTab: 'r1',
      drafts: {},
    });
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs the request at the cursor and shows its answer, also as a table', async () => {
    expect(calls()[0]).toMatchObject({ session: 'rest:r1', method: 'GET' });
    await clickButton(fixture, 'Run (Ctrl+Enter)');
    expect(calls().at(-1)).toMatchObject({ method: 'GET', path: '_cluster/health' });
    expect(root().querySelector('.rest-status')?.textContent).toContain('200');
    await write('GET missing\n\nPOST _search\n{"size": 1}\n', '"size"');
    root()
      .querySelector('app-db-rest-console')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await settle();
    expect(calls().at(-1)).toMatchObject({ method: 'POST', path: '_search', body: { size: 1 } });
    await clickButton(fixture, 'Show as a table');
    expect(root().querySelector('.rest-table')?.textContent).toContain('user.city');
    expect(root().querySelector('.rest-table')?.textContent).toContain('Lima');
    await write('GET missing\n', 'missing');
    await clickButton(fixture, 'Run (Ctrl+Enter)');
    expect(root().querySelector('.rest-status .failed')?.textContent).toBe('404');
    // The cluster's view, and the history.
    await clickButton(fixture, 'Nodes');
    expect(calls().at(-1)).toMatchObject({ path: '_cat/nodes?v' });
    await clickButton(fixture, 'Health');
    expect(root().querySelector('.rest-history')?.textContent).toContain('GET _cat/nodes?v');
  });

  it('asks for the name of an index to delete and refuses a body that is not JSON', async () => {
    await write('DELETE shop\n', 'shop');
    await clickButton(fixture, 'Run (Ctrl+Enter)');
    expect(root().querySelector('.rest-confirm')?.textContent).toContain('shop');
    const input = root().querySelector<HTMLInputElement>('.rest-confirm input')!;
    input.value = 'shop';
    input.dispatchEvent(new Event('input'));
    await settle();
    await clickButton(fixture, 'Run', root().querySelector('.rest-confirm')!);
    expect(calls().at(-1)).toMatchObject({ method: 'DELETE', confirmName: 'shop' });
    await write('PUT shop\n{oops\n', 'shop');
    await clickButton(fixture, 'Run (Ctrl+Enter)');
    expect(root().querySelector('.rest-error')?.textContent).toContain('not JSON');
    await write('no request here', 'no');
    await clickButton(fixture, 'Run (Ctrl+Enter)');
    expect(root().querySelector('.rest-error')?.textContent).toContain('METHOD path');
    await write('DELETE shop\n', 'shop');
    await clickButton(fixture, 'Run (Ctrl+Enter)');
    await clickButton(fixture, 'Cancel', root().querySelector('.rest-confirm')!);
    expect(root().querySelector('.rest-confirm')).toBeNull();
  });

  it('copies a request as cURL without the password', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await write('POST shop/_search\n{"query": {"match_all": {}}}\n', 'query');
    await clickButton(fixture, 'Copy as cURL');
    expect(writeText).toHaveBeenCalled();
    const copied = root().querySelector('.rest-curl')?.textContent ?? '';
    expect(copied).toContain('curl -X POST "http://es:9200/shop/_search"');
    expect(copied).not.toContain('elastic');
  });

  it('opens from the menu of an Elasticsearch connection', async () => {
    const section = fixture.debugElement.injector.get(DbSection);
    section.closeTab('r1');
    await settle();
    const item = root().querySelector<HTMLElement>('[role="treeitem"]')!;
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    await settle();
    buttons(root().querySelector('[role="menu"]')!, 'Query DSL console')[0].click();
    await settle();
    expect(section.tabs.active()?.kind).toBe('rest');
  });
});
