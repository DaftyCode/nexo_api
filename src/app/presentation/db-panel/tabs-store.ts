import { computed, signal } from '@angular/core';
import { DbTab, SqlDraft } from '../../domain/db/session';
import { moveWithin } from '../../domain/ordering';

export type { DbTab, SqlDraft } from '../../domain/db/session';

/**
 * The tabs of the editor area, to the right of the navigator: connection editors, SQL
 * scripts and objects, with the text of each script. They are kept in the workspace session.
 */
export class DbTabsStore {
  readonly tabs = signal<readonly DbTab[]>([]);
  readonly activeId = signal('');
  readonly drafts = signal<Readonly<Record<string, SqlDraft>>>({});
  readonly active = computed(() => this.tabs().find((tab) => tab.id === this.activeId()));

  constructor(private readonly id: () => string) {}

  /**
   * The tab already open for the same thing: the editor of a connection, an object or a saved
   * script. A SQL tab without a script is never the same as another one.
   */
  find(tab: Omit<DbTab, 'id'>, draft?: SqlDraft): DbTab | undefined {
    return this.tabs().find((other) => {
      if (other.kind !== tab.kind || other.connection !== tab.connection) return false;
      if (tab.kind === 'connection') return !!tab.connection;
      if (tab.kind === 'object') return other.path?.join('/') === tab.path?.join('/');
      if (['sessions', 'locks', 'dashboard', 'native'].includes(tab.kind)) return true;
      if (tab.kind === 'diagram')
        return tab.diagram
          ? other.diagram === tab.diagram
          : !other.diagram && other.path?.join('/') === tab.path?.join('/');
      return !!draft?.script && this.drafts()[other.id]?.script === draft.script;
    });
  }

  /** Opens a tab, or shows the one already open for the same thing. */
  open(tab: Omit<DbTab, 'id'>, draft?: SqlDraft): DbTab {
    const existing = this.find(tab, draft);
    if (existing) {
      this.activeId.set(existing.id);
      return existing;
    }
    const opened = { ...tab, id: this.id() };
    this.tabs.update((tabs) => [...tabs, opened]);
    if (tab.kind === 'sql')
      this.drafts.update((all) => ({ ...all, [opened.id]: draft ?? { text: '', cursor: 0 } }));
    this.activeId.set(opened.id);
    return opened;
  }

  update(id: string, change: Partial<Omit<DbTab, 'id'>>) {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)));
  }

  draft(id: string): SqlDraft {
    return this.drafts()[id] ?? { text: '', cursor: 0 };
  }
  setDraft(id: string, change: Partial<SqlDraft>) {
    this.drafts.update((all) => ({ ...all, [id]: { ...this.draft(id), ...change } }));
  }

  /** Closes a tab; the one beside it becomes active. */
  close(id: string) {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const rest = tabs.filter((tab) => tab.id !== id);
    this.tabs.set(rest);
    this.drafts.update(({ [id]: _closed, ...others }) => others);
    if (this.activeId() === id) this.activeId.set(rest[Math.min(index, rest.length - 1)]?.id ?? '');
  }

  /** Moves a tab before or after another one, as dragging it. */
  move(id: string, over: string, side: 'before' | 'after') {
    const ids = this.tabs().map((tab) => tab.id);
    const to = ids.indexOf(over) + (side === 'after' ? 1 : 0);
    const order = moveWithin(ids, ids.indexOf(id), to);
    this.tabs.update((tabs) => order.map((key) => tabs.find((tab) => tab.id === key)!));
  }

  /** Opens the tabs of a stored session again. */
  restore(tabs: readonly DbTab[], drafts: Readonly<Record<string, SqlDraft>>, active: string) {
    this.tabs.set([...tabs]);
    this.drafts.set({ ...drafts });
    this.activeId.set(tabs.some((tab) => tab.id === active) ? active : (tabs[0]?.id ?? ''));
  }
}
