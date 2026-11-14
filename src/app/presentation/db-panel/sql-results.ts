import { signal } from '@angular/core';
import type { DatabaseUseCases } from '../../application/database-use-cases';
import { ResultTab, addResult, closeResults, rerunResult } from '../../domain/db/results';

/** A line of the «Messages» panel: what ran without rows, warnings of the server, errors. */
export interface SqlMessage {
  id: number;
  kind: 'info' | 'warning' | 'error';
  /** A message key, or text as it came. */
  text: string;
  params?: Record<string, string>;
  at: number;
  /** Where the error is in the editor, from 1. */
  line?: number;
  column?: number;
  /** The same place, as an offset of the editor. */
  offset?: number;
}

/** What the results need from the tab around them. */
export interface ResultsContext {
  cases: () => Promise<DatabaseUseCases>;
  workspace: () => string;
  session: string;
  max: () => number;
  /** Runs a statement again into its tab. */
  rerun: (tab: ResultTab) => Promise<void>;
}

/** Rows read at a time, for the first page and «read more». */
export const PAGE_ROWS = 200;
/** The messages kept. */
const MESSAGES = 200;

/**
 * The results of a SQL tab: a tab per query, kept until there are too many, with its cursor
 * open in the driver while there is more to read; and the messages of what ran.
 */
export class SqlResults {
  readonly tabs = signal<readonly ResultTab[]>([]);
  readonly active = signal('');
  readonly messages = signal<readonly SqlMessage[]>([]);
  /** The result shown in a floating window. */
  readonly detached = signal('');
  /** Results run again every so many seconds. */
  readonly repeating = signal<Readonly<Record<string, number>>>({});
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private counter = 0;

  constructor(private readonly context: ResultsContext) {}

  note(message: Omit<SqlMessage, 'id' | 'at'>) {
    this.messages.update((list) =>
      [...list, { ...message, id: ++this.counter, at: Date.now() }].slice(-MESSAGES),
    );
  }
  clearMessages() {
    this.messages.set([]);
  }

  /** Adds a result; the tabs that close for it lose their cursors. */
  add(tab: ResultTab, reuse: boolean) {
    const { tabs, closed } = addResult(this.tabs(), tab, { reuse, max: this.context.max() });
    this.tabs.set(tabs);
    this.active.set(tab.id);
    this.release(closed);
  }

  /** Puts a new run of a result's statement in its tab. */
  replace(id: string, fresh: ResultTab) {
    const old = this.tabs().find((tab) => tab.id === id);
    if (!old) return;
    this.tabs.set(rerunResult(this.tabs(), id, fresh));
    if (old.cursor) void this.closeCursor(old.cursor);
  }

  pin(id: string) {
    this.tabs.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
    );
  }

  close(pick: (tab: ResultTab) => boolean) {
    const { tabs, closed } = closeResults(this.tabs(), pick);
    this.tabs.set(tabs);
    if (!tabs.some((tab) => tab.id === this.active())) this.active.set(tabs.at(-1)?.id ?? '');
    if (closed.some((tab) => tab.id === this.detached())) this.detached.set('');
    this.release(closed);
  }

  /** Reads the next page of a result. */
  async more(id: string) {
    const tab = this.tabs().find((other) => other.id === id);
    if (!tab?.cursor) return;
    const cases = await this.context.cases();
    const started = Date.now();
    try {
      const page = await cases.statements.fetch(
        this.context.workspace(),
        this.context.session,
        tab.cursor,
        PAGE_ROWS,
      );
      this.update(id, (current) => ({
        ...current,
        rows: [...current.rows, ...page.rows],
        cursor: page.cursor ?? undefined,
        fetchMs: current.fetchMs + (Date.now() - started),
      }));
    } catch {
      // The driver closed it (too many cursors open): the rest needs running it again.
      this.update(id, (current) => ({ ...current, cursor: undefined, lost: true }));
    }
  }

  /** Runs a result's statement again every `seconds`, until it is stopped (0). */
  repeat(id: string, seconds: number) {
    clearInterval(this.timers.get(id));
    this.timers.delete(id);
    this.repeating.update(({ [id]: _stopped, ...others }) => others);
    if (seconds <= 0) return;
    this.repeating.update((all) => ({ ...all, [id]: seconds }));
    this.timers.set(
      id,
      setInterval(() => {
        const tab = this.tabs().find((other) => other.id === id);
        if (tab) void this.context.rerun(tab);
      }, seconds * 1000),
    );
  }

  /** The session closed or changed: no cursor can be read any more. */
  sessionLost() {
    this.tabs.update((tabs) =>
      tabs.map((tab) => (tab.cursor ? { ...tab, cursor: undefined, lost: true } : tab)),
    );
  }

  /** Stops what keeps running when the tab closes. */
  dispose() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private update(id: string, change: (tab: ResultTab) => ResultTab) {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.id === id ? change(tab) : tab)));
  }

  private release(closed: readonly ResultTab[]) {
    for (const tab of closed) {
      this.repeat(tab.id, 0);
      if (tab.cursor) void this.closeCursor(tab.cursor);
    }
  }

  private async closeCursor(cursor: string) {
    const cases = await this.context.cases();
    await cases.statements.closeCursor(this.context.workspace(), this.context.session, cursor);
  }
}
