import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DbConnectionEditor } from './db-connection-editor';
import { DbNavigator } from './db-navigator';
import { DbObjectTab } from './db-object-tab';
import { DbSqlTab } from './db-sql-tab';
import { ListDrag } from './workspace/list-drag';
import { DbTransactions } from './db-transactions';
import { DbConsole } from './db-console';
import { DbTransfer } from './db-transfer';
import { DbSearch } from './db-search';
import { DbTableEditor } from './db-table-editor';
import { DbDiagram } from './db-diagram';
import { DbLocks } from './db-locks';
import { DbSessions } from './db-sessions';
import { DbDashboard } from './db-dashboard';
import { hasPendingWrites } from './db-panel/sql-transaction';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { ModuleDownload } from './module-download';
import { Splitter } from './splitter';
import { StudioIcon } from './studio-icon';

/** The narrowest and widest the navigator gets, in pixels. */
const NAVIGATOR = { min: 200, initial: 300 };

/**
 * The database section, laid out as DBeaver: the navigator of connections on the left, and
 * the editors of what is opened in it in tabs on the right. Connections of every database
 * module live here; their drivers are downloaded the first time they are used.
 */
@Component({
  imports: [
    TranslocoPipe,
    DbNavigator,
    DbConnectionEditor,
    DbSqlTab,
    DbObjectTab,
    ModuleDownload,
    Splitter,
    StudioIcon,
    DbTransactions,
    DbConsole,
    DbTransfer,
    DbSearch,
    DbTableEditor,
    DbDiagram,
    DbSessions,
    DbLocks,
    DbDashboard,
  ],
  providers: [DbSection],
  host: {
    '(keydown)': 'shortcut($event)',
    '(window:keydown)': 'searchKey($event)',
    '(window:beforeunload)': 'leaving($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-panel',
  styleUrl: './db-panel.scss',
  templateUrl: './db-panel.html',
})
export class DbPanel {
  protected readonly section = inject(DbSection);
  protected readonly tabs = this.section.tabs;
  protected readonly width = signal(NAVIGATOR.initial);
  protected readonly folded = signal(false);
  /** The active tab, as a list so that each tab is drawn by its own components. */
  protected readonly shownTabs = computed(() => {
    const active = this.tabs.active();
    return active ? [active] : [];
  });
  /** SQL tabs whose transaction has changes a rollback would undo. */
  protected readonly pendingTabs = computed(() => {
    this.tabs.tabs();
    return this.section.editors.all().filter((runner) => hasPendingWrites(runner.transaction()))
      .length;
  });
  /** Editor tabs dragged to put them in another order. */
  protected readonly drag = new ListDrag('x', (id, over, side) => this.tabs.move(id, over, side));

  /** The name of a tab: its connection, script or object. */
  protected title(tab: DbTab): string {
    const connection = this.section.connection(tab.connection)?.name ?? '';
    if (tab.kind === 'connection') return connection || tab.title;
    if (tab.kind === 'object') return tab.title;
    if (tab.kind === 'diagram')
      return (
        this.section.diagrams.saved().find((each) => each.id === tab.diagram)?.name ?? tab.title
      );
    if (tab.kind === 'console') return `${connection} · Console`;
    if (tab.kind === 'sessions') return `${connection} · Sessions`;
    if (tab.kind === 'locks') return `${connection} · Locks`;
    if (tab.kind === 'dashboard') return `${connection} · Dashboard`;
    const script = this.section
      .scripts()
      .find((document) => document.id === this.tabs.drafts()[tab.id]?.script);
    return script ? script.name : `${connection} · SQL`;
  }
  protected kindIcon(tab: DbTab) {
    if (tab.kind === 'diagram') return 'schema';
    if (tab.kind === 'sessions') return 'bars';
    if (tab.kind === 'locks') return 'lock';
    if (tab.kind === 'dashboard') return 'datasets';
    return tab.kind === 'sql' ? 'code' : tab.kind === 'console' ? 'console' : 'databases';
  }
  protected dirty(tab: DbTab) {
    if (tab.kind === 'diagram') return this.section.diagrams.unsaved(tab.id);
    return tab.kind === 'sql' && !!this.tabs.drafts()[tab.id]?.dirty;
  }
  /** Leaving Nexo with changes not committed: the browser asks first. */
  protected leaving(event: BeforeUnloadEvent) {
    if (this.section.transactions.anyPending()) event.preventDefault();
  }

  /** Ctrl+] opens a SQL script on the connection last chosen, as in DBeaver. */
  /** Ctrl+H searches the databases, as DBeaver, wherever the focus is in the section. */
  protected searchKey(event: KeyboardEvent) {
    const control = event.ctrlKey || event.metaKey;
    if (!control || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'h') return;
    event.preventDefault();
    this.section.searching.set(true);
  }

  protected shortcut(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    if (event.key !== ']') return;
    const active = this.section.active();
    if (!this.section.connection(active)) return;
    event.preventDefault();
    this.section.newScript(active);
  }

  protected resize(width: number) {
    this.width.set(Math.max(NAVIGATOR.min, width));
  }

  protected production(tab: DbTab) {
    return !!tab.connection && this.section.typeOf(tab.connection) === 'production';
  }

  /** Arrows move between tabs, as in a WAI-ARIA tab list. */
  protected tabKey(event: KeyboardEvent, tab: DbTab) {
    const tabs = this.tabs.tabs();
    const index = tabs.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : undefined;
    if (!next) return;
    event.preventDefault();
    this.tabs.activeId.set(next.id);
    const list = (event.currentTarget as HTMLElement).parentElement;
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus());
  }
}
