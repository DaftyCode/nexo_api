import { computed, signal } from '@angular/core';

/**
 * A tab of the editor area of the database section. DB-05 opens connection editors; the SQL
 * editor (DB-06) and object editors (DB-08) add their kinds.
 */
export interface DbTab {
  id: string;
  kind: 'connection';
  /** The saved connection it belongs to; empty for a connection not saved yet. */
  connection: string;
  /** Shown while it has no saved connection to take its name from. */
  title: string;
}

/** The tabs of the editor area, to the right of the navigator. */
export class DbTabsStore {
  readonly tabs = signal<readonly DbTab[]>([]);
  readonly activeId = signal('');
  readonly active = computed(() => this.tabs().find((tab) => tab.id === this.activeId()));

  constructor(private readonly id: () => string) {}

  /** Opens a tab, or shows the one already open for the same thing. */
  open(tab: Omit<DbTab, 'id'>): DbTab {
    const existing = tab.connection
      ? this.tabs().find((other) => other.kind === tab.kind && other.connection === tab.connection)
      : undefined;
    if (existing) {
      this.activeId.set(existing.id);
      return existing;
    }
    const opened = { ...tab, id: this.id() };
    this.tabs.update((tabs) => [...tabs, opened]);
    this.activeId.set(opened.id);
    return opened;
  }

  update(id: string, change: Partial<Omit<DbTab, 'id'>>) {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)));
  }

  /** Closes a tab; the one beside it becomes active. */
  close(id: string) {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const rest = tabs.filter((tab) => tab.id !== id);
    this.tabs.set(rest);
    if (this.activeId() === id) this.activeId.set(rest[Math.min(index, rest.length - 1)]?.id ?? '');
  }

  /** Closes the tabs of a connection that was deleted. */
  closeConnection(connection: string) {
    for (const tab of this.tabs().filter((other) => other.connection === connection))
      this.close(tab.id);
  }
}
