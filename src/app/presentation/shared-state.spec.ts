import { TestBed } from '@angular/core/testing';
import { CollectionItem, WorkspaceDocument, fromItem } from '../domain/models';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { SharedState } from './shared-state';
import { WorkspaceState } from './workspace-state';

const request = (id: string, url: string): CollectionItem => ({
  id,
  name: id,
  request: { method: 'GET', url },
});
const shop = (items: CollectionItem[]): WorkspaceDocument => ({
  id: 'c1',
  workspace_id: 'local',
  kind: 'collection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { info: { name: 'Shop', schema: '' }, item: items },
});
const link = {
  collection: 'c1',
  name: 'Shop',
  path: 'D:/Drive/Shop.nexo-collection',
  encrypted: true,
  environments: [],
  conflicts: [],
};

describe('SharedState', () => {
  let api: TestApi;
  let state: WorkspaceState;
  let shared: SharedState;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: testProviders() });
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    shared = TestBed.inject(SharedState);
    await TestBed.inject(WorkspaceState).refresh();
  });

  it("shows a teammate's change with each open tab still on its request", async () => {
    api.documentsStore.push(shop([request('a', '/a'), request('b', '/b')]));
    await state.refresh();
    state.tabsStore.open(fromItem(request('b', '/b'), 'tab-b'), 'c1', [1]);
    state.tabsStore.open(fromItem(request('a', '/a'), 'tab-a'), 'c1', [0]);
    state.tabsStore.edit({ ...state.active()!.request, url: '/mine' });
    // A teammate added a request first and changed both.
    api.documentsStore[0] = shop([request('n', '/n'), request('a', '/a2'), request('b', '/b2')]);
    api.responses['shared.poll'] = { changed: ['c1'], links: [link] };
    await shared.poll();
    const [b, a] = state.tabs();
    expect([b!.path, b!.request.url]).toEqual([[2], '/b2']);
    // Unsaved work stays as it was.
    expect([a!.path, a!.request.url]).toEqual([[1], '/mine']);
    expect(state.toast()).toMatchObject({ title: 'Updated from the shared file' });
    expect(shared.byCollection().get('c1')?.path).toBe(link.path);
    // A failed look is tried again later, quietly.
    api.responses['shared.poll'] = () => {
      throw new Error('gone');
    };
    await shared.poll();
    shared.show([]);
    expect(shared.links()).toEqual([]);
  });

  it('shares, brings in, reloads, resolves, stops sharing and shows the key', async () => {
    api.documentsStore.push(shop([request('a', '/a')]));
    api.responses['shared.share'] = { collection: 'c1', key: 'nexo-team-key-1' };
    api.responses['shared.status'] = { links: [link] };
    api.responses['shared.poll'] = { changed: [], links: [link] };
    expect(await shared.share('c1', link.path, true, [])).toBe('nexo-team-key-1');
    expect(shared.links()).toEqual([link]);
    api.responses['shared.share'] = { collection: 'c1' };
    expect(await shared.share('c1', link.path, false, [])).toBe('');
    api.responses['shared.link'] = { collection: 'c2' };
    expect(await shared.link('D:/Drive/Team.nexo-collection', 'k')).toBe('c2');
    api.responses['shared.sync'] = { links: [link] };
    await shared.sync('c1');
    api.responses['shared.resolve'] = { links: [link] };
    await shared.resolve('c1', 'a', 'mine');
    await shared.resolve('c1', 'a', 'theirs');
    api.responses['shared.key'] = { key: 'nexo-team-key-1' };
    expect(await shared.key('c1')).toBe('nexo-team-key-1');
    api.responses['shared.unlink'] = { links: [] };
    await shared.unlink('c1');
    expect(shared.links()).toEqual([]);
    expect(api.calls.map((call) => call.operation)).toEqual(
      expect.arrayContaining(['shared.share', 'shared.link', 'shared.sync', 'shared.resolve']),
    );
    // Another workspace shows its own links.
    api.responses['shared.status'] = () => {
      throw new Error('offline');
    };
    state.workspaceId.set('w2');
    TestBed.tick();
    await new Promise((done) => setTimeout(done, 0));
    expect(shared.links()).toEqual([]);
  });
});
