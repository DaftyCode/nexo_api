import { DbTabsStore } from './tabs-store';

describe('DbTabsStore', () => {
  let counter = 0;
  const store = () => new DbTabsStore(() => `t${++counter}`);

  it('opens a tab once per connection editor, object and saved script', () => {
    const tabs = store();
    const editor = tabs.open({ kind: 'connection', connection: 'a', title: 'A' });
    expect(tabs.open({ kind: 'connection', connection: 'a', title: 'A' }).id).toBe(editor.id);
    const object = tabs.open({ kind: 'object', connection: 'a', title: 'orders', path: ['x'] });
    expect(tabs.open({ kind: 'object', connection: 'a', title: 'o', path: ['x'] }).id).toBe(
      object.id,
    );
    const script = tabs.open(
      { kind: 'sql', connection: 'a', title: 'S' },
      { text: '', cursor: 0, script: 'd1' },
    );
    expect(
      tabs.open({ kind: 'sql', connection: 'a', title: 'S' }, { text: '', cursor: 0, script: 'd1' })
        .id,
    ).toBe(script.id);
    // A new script always opens anew.
    tabs.open({ kind: 'sql', connection: 'a', title: 'SQL' });
    tabs.open({ kind: 'sql', connection: 'a', title: 'SQL' });
    expect(tabs.tabs()).toHaveLength(5);
  });

  it('keeps the text of each SQL tab, and drops it with the tab', () => {
    const tabs = store();
    const tab = tabs.open(
      { kind: 'sql', connection: 'a', title: 'SQL' },
      { text: 'select 1', cursor: 8 },
    );
    tabs.setDraft(tab.id, { text: 'select 2', dirty: true });
    expect(tabs.draft(tab.id)).toEqual({ text: 'select 2', cursor: 8, dirty: true });
    tabs.close(tab.id);
    expect(tabs.drafts()).toEqual({});
    expect(tabs.activeId()).toBe('');
  });

  it('moves tabs as dragged, and restores a session', () => {
    const tabs = store();
    const [a, b, c] = ['A', 'B', 'C'].map((title) =>
      tabs.open({ kind: 'connection', connection: title, title }),
    );
    tabs.move(c.id, a.id, 'before');
    expect(tabs.tabs().map((tab) => tab.title)).toEqual(['C', 'A', 'B']);
    tabs.move(c.id, b.id, 'after');
    expect(tabs.tabs().map((tab) => tab.title)).toEqual(['A', 'B', 'C']);
    tabs.restore([a], {}, 'missing');
    expect(tabs.activeId()).toBe(a.id);
  });
});
