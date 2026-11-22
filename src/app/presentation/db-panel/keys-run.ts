import { computed, signal } from '@angular/core';
import type { KvChange } from '../../application/database-use-cases';
import { KvKey, KvValue, keyRows, sameKey } from '../../domain/db/keyvalue';
import { KeysConsole } from './keys-console';
import type { DbSection } from './section';

/** Keys read at a time. */
export const KEY_PAGE = 200;

/**
 * A database of Redis or Valkey open in a tab (DB-35), on its own session: its keys by pages
 * of `SCAN` grouped by `:`, filtered by a pattern and a type, the sheet of the key chosen,
 * the console and the server's view. Closing the tab closes the session.
 */
export class KeysRun {
  readonly session: string;
  readonly status = signal<'closed' | 'opening' | 'open' | 'error'>('closed');
  readonly error = signal('');
  readonly keys = signal<readonly KvKey[]>([]);
  /** Where to go on; none when every key was read. */
  readonly cursor = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly pattern = signal('');
  readonly type = signal('');
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly rows = computed(() => keyRows(this.keys(), ':', this.expanded()));
  /** The key whose sheet is shown, with its value as last read. */
  readonly selected = signal<KvValue | undefined>(undefined);
  readonly console: KeysConsole;

  constructor(
    readonly section: DbSection,
    readonly tab: string,
  ) {
    this.session = `keys:${tab}`;
    this.console = new KeysConsole(this);
  }

  workspace() {
    return this.section.state.workspaceId();
  }
  private current() {
    return this.section.tabs.tabs().find((tab) => tab.id === this.tab);
  }
  async cases() {
    return (await this.section.cases()).keyValue;
  }

  /** Opens the session on the tab's database and reads the first keys. */
  async start() {
    if (this.status() !== 'closed') return;
    this.status.set('opening');
    try {
      const tab = this.current();
      const connection = tab && this.section.connection(tab.connection);
      if (!tab || !connection) throw new Error('The connection is no longer there');
      if (!(await this.section.ensure(this.section.driverOf(tab.connection))))
        throw new Error('db.dashboard.module');
      const cases = await this.section.cases();
      await cases.statements.open(
        this.workspace(),
        connection,
        this.session,
        this.section.state.scopes(),
        { database: tab.path?.[0] ?? 'db0', manual: false },
      );
      this.status.set('open');
      await this.load();
    } catch (error) {
      this.status.set('error');
      this.error.set(this.section.state.describe(error));
    }
  }

  /** Reads the keys again from the start, or the next page. */
  async load(more = false) {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await (
        await this.cases()
      ).scan(this.workspace(), this.session, {
        pattern: this.pattern().trim() || undefined,
        type: this.type() || undefined,
        cursor: more ? this.cursor() : undefined,
        count: KEY_PAGE,
      });
      this.keys.update((keys) => (more ? [...keys, ...page.keys] : page.keys));
      this.cursor.set(page.cursor ?? undefined);
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  toggle(folder: string) {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  }

  /** Reads a key's sheet; with `more`, the next elements of its collection. */
  async select(key: KvKey['key'], more = false) {
    this.error.set('');
    try {
      const shown = this.selected();
      const cursor = more && shown ? (shown.cursor ?? undefined) : undefined;
      const value = await (await this.cases()).get(this.workspace(), this.session, key, cursor);
      this.selected.set(
        more && shown ? { ...value, elements: [...shown.elements, ...value.elements] } : value,
      );
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    }
  }

  /**
   * Applies a change after asking what the connection asks: deleting a key, and every
   * change on production. Then reads the key (or the list) again.
   */
  async write(change: KvChange): Promise<boolean> {
    const production = this.section.rulesOf(this.current()?.connection ?? '').confirmWrites;
    const asked = change.action === 'delete' || production;
    const message =
      change.action === 'delete' ? 'db.kv.confirmDelete' : 'db.edit.confirmProduction';
    if (asked && !this.section.state.confirm(message)) return false;
    this.error.set('');
    try {
      const cases = await this.cases();
      const written = await cases.write(this.workspace(), this.session, {
        ...change,
        ...(asked ? { confirm: true } : {}),
      });
      if (change.action === 'delete') {
        this.selected.set(undefined);
        this.keys.update((keys) => keys.filter((key) => !sameKey(key.key, change.key)));
      } else {
        if (change.action === 'rename' || change.type) await this.load();
        await this.select(written.key);
      }
      return true;
    } catch (error) {
      this.error.set(this.section.state.describe(error));
      return false;
    }
  }

  async stop() {
    const was = this.status();
    this.status.set('closed');
    if (was !== 'open') return;
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
  }
}
