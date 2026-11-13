import { Collection, RequestTab, WorkspaceDocument, fromItem, newRequest } from './models';
import { moveWithin, ordered } from './ordering';
import { readSession, restoreTabs, sessionId, sessionOf } from './workspace-session';

const collection = (id: string, value: Collection): WorkspaceDocument => ({
  id,
  workspace_id: 'w',
  kind: 'collection',
  name: id,
  revision: 1,
  updated_at: 0,
  value,
});
const api = (): Collection => ({
  info: { name: 'API', schema: 'x' },
  item: [
    { id: 'u', name: 'Users', request: { method: 'GET', url: 'http://api/users' } },
    {
      name: 'Orders',
      item: [{ name: 'List orders', request: { method: 'GET', url: 'http://api/orders' } }],
    },
  ],
});
let next = 0;
const id = () => `n${++next}`;
const tab = (overrides: Partial<RequestTab>): RequestTab => ({
  id: 't',
  request: newRequest('r'),
  documentId: '',
  path: [],
  dirty: false,
  ...overrides,
});

describe('workspace sessions', () => {
  it('keep saved tabs by their item and unsaved changes as they were typed', () => {
    const documents = [collection('c', api())];
    const users = fromItem(api().item[0], 'r1');
    const file = (name: string, content: string) => ({ name, contentType: '', size: 1, content });
    const edited = {
      ...fromItem(api().item[1].item![0], 'r2'),
      url: 'http://api/orders?page=2',
      bodyMode: 'formdata',
      form: [
        {
          key: 'f',
          value: '',
          enabled: true,
          type: 'file' as const,
          src: 'a.txt',
          files: [file('a.txt', 'YQ==')],
        },
      ],
      bodyFile: { src: 'b.bin', file: file('b.bin', 'Yg==') },
    };
    const blank = newRequest('r3');
    const session = sessionOf(
      [
        tab({ id: 'a', request: users, documentId: 'c', path: [0] }),
        tab({ id: 'b', request: edited, documentId: 'c', path: [1, 0], dirty: true }),
        tab({ id: 'n', request: blank }),
      ],
      'b',
      ['c'],
      documents,
    );
    expect(session.tabs[0]).toEqual({
      id: 'a',
      documentId: 'c',
      path: [0],
      itemId: 'u',
      itemName: 'Users',
    });
    expect(session.tabs[1].draft?.url).toBe('http://api/orders?page=2');
    // The files chosen in the tab are kept by name only, as collections keep them.
    expect(JSON.stringify(session.tabs[1].draft)).not.toContain('YQ==');
    expect(session.tabs[1].draft?.bodyFile).toEqual({ src: 'b.bin' });
    expect(session.tabs[1].draft?.form[0]).toEqual(expect.objectContaining({ src: 'a.txt' }));
    expect(edited.bodyFile.file).toBeDefined();
    expect(session.tabs[1]).toEqual(
      expect.objectContaining({ dirty: true, itemName: 'List orders' }),
    );
    // A request not saved in a collection keeps the whole request.
    expect(session.tabs[2]).toEqual(
      expect.objectContaining({
        documentId: '',
        draft: expect.objectContaining({ name: 'Untitled request' }),
      }),
    );
    expect(sessionOf([tab({})], 't', ['c'], documents, false)).toEqual({
      tabs: [],
      activeTab: '',
      collections: ['c'],
    });
    expect(sessionId('w')).toBe('session-w');
  });

  it('reopen tabs as they were, following moved items and dropping deleted ones', () => {
    const moved = api();
    // Users moved into the Orders folder; List orders deleted.
    moved.item = [{ name: 'Orders', item: [moved.item[0]] }];
    const stored = readSession(
      JSON.parse(
        JSON.stringify(
          sessionOf(
            [
              tab({ id: 'a', request: fromItem(api().item[0], 'r'), documentId: 'c', path: [0] }),
              tab({
                id: 'b',
                documentId: 'c',
                path: [1, 0],
                request: fromItem(api().item[1].item![0], 'r'),
              }),
              tab({
                id: 'd',
                documentId: 'c',
                path: [1, 0],
                dirty: true,
                request: { ...newRequest('r'), name: 'Changed', url: 'http://api/changed' },
              }),
              tab({ id: 'n', request: { ...newRequest('r'), url: 'http://new' }, dirty: true }),
            ],
            'b',
            ['c'],
            [collection('c', api())],
          ),
        ),
      ),
    );
    const restored = restoreTabs(stored, [collection('c', moved)], id);
    expect(restored.dropped).toBe(1);
    expect(restored.tabs.map((t) => [t.id, t.documentId, t.path, t.dirty])).toEqual([
      ['a', 'c', [0, 0], false],
      // Its request was deleted, but its changes are kept, detached from the collection.
      ['d', '', [], true],
      ['n', '', [], true],
    ]);
    expect(restored.tabs[0].request.url).toBe('http://api/users');
    expect(restored.tabs[1].request.url).toBe('http://api/changed');
    // The active tab was dropped: the last one is active.
    expect(restored.activeTab).toBe('n');
  });

  it('do not reopen another request found at the path of an item without id', () => {
    const stored = sessionOf(
      [tab({ id: 'b', documentId: 'c', path: [1, 0], request: newRequest('r') })],
      'b',
      [],
      [collection('c', api())],
    );
    const renamed = api();
    renamed.item[1].item![0].name = 'Another request';
    expect(restoreTabs(stored, [collection('c', renamed)], id).tabs).toEqual([]);
    expect(restoreTabs(stored, [collection('c', api())], id).tabs).toHaveLength(1);
  });

  it('read stored sessions leniently', () => {
    expect(readSession(undefined)).toEqual({ tabs: [], activeTab: '', collections: [] });
    expect(
      readSession({
        tabs: [{ id: 'a', path: [0, -1, 'x'], draft: 'x' }, { path: [] }, null],
        activeTab: 3,
        collections: ['c', 4],
        section: 'mongo',
      }),
    ).toEqual({
      tabs: [{ id: 'a', documentId: '', path: [0] }],
      activeTab: '',
      collections: ['c'],
      section: 'mongo',
    });
  });

  it('order lists by the ids the person dragged them to', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(ordered(list, ['c', 'gone', 'a']).map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
    expect(moveWithin(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a']);
    expect(moveWithin(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveWithin(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'b', 'c']);
    expect(moveWithin(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});
