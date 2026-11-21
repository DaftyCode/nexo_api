import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { TransferRequest } from './transfer-request';
import type { StructureRequest } from './structure-draft';
import type { DatabaseUseCases } from '../../application/database-use-cases';
import { PasswordPrompts } from './password-prompt';
import { DATABASES, MODULES } from '../../composition/providers';
import {
  ConnectionType,
  connectionType,
  dbFolders,
  isDbConnection,
  readDbConnection,
} from '../../domain/db/connection';
import { NavigatorRow, navigatorRows } from '../../domain/db/rows';
import { SqlDraft, restoredDrafts, storedDrafts } from '../../domain/db/session';
import { readScript } from '../../domain/db/sql';
import { QueryStyle } from '../../domain/db/table-query';
import { DbBookmark, DbNode, QuoteStyle, keyPath, nodeKey } from '../../domain/db/tree';
import { ModuleSummary } from '../../domain/modules';
import { WorkspaceDocument } from '../../domain/models';
import { WorkspaceState } from '../workspace-state';
import { DriverFacts } from './drivers';
import { OpenEditors } from './editors';
import { DbTabsStore } from './tabs-store';
import { SectionDiagrams } from './diagrams';
import { SectionDashboards } from './dashboards';
import { DbTreeStore } from './tree-store';
import { SchemaCache } from './schema-cache';
import { SectionTransactions } from './transactions';

/** A module the section waits for: the download dialog asks, then says how it went. */
export interface ModuleWait {
  module: ModuleSummary;
  done: (installed: boolean) => void;
}

/**
 * The state of the database section, shared by its navigator and its editors: the saved
 * connections, the tree with its sessions, the editor tabs, the bookmarks and the view, kept
 * in the workspace session.
 */
@Injectable()
export class DbSection {
  readonly state = inject(WorkspaceState);
  readonly modules = inject(MODULES);
  private readonly loader = inject(DATABASES);
  /** Asks for the password of a connection that keeps none, when a session of it opens. */
  readonly passwords = new PasswordPrompts();
  readonly cases: () => Promise<DatabaseUseCases> = this.passwords.asking(this.loader);
  /** The module whose download dialog is open, if any. */
  readonly moduleWait = signal<ModuleWait | undefined>(undefined);
  readonly tree = new DbTreeStore({
    cases: this.cases,
    workspace: () => this.state.workspaceId(),
    scopes: () => this.state.scopes(),
    ensure: (driver) => this.ensure(driver),
    describe: (error) => this.state.describe(error),
    learn: (connection) => this.drivers.learn(connection),
  });
  readonly tabs = new DbTabsStore(() => this.state.cases.files.id());
  readonly bookmarks = signal<readonly DbBookmark[]>([]);
  /** The simple view hides system objects and administration folders. */
  readonly simple = signal(true);
  readonly text = signal('');
  /** The connection last chosen in the navigator. */
  readonly active = signal('');
  /** What the driver of each connection said about itself. */
  readonly drivers = new DriverFacts({
    connection: (id) => this.connection(id),
    cases: () => this.cases(),
    workspace: () => this.state.workspaceId(),
  });
  readonly quoteStyle = (connection: string): QuoteStyle => this.drivers.quoteStyle(connection);
  readonly sqlStyle = (connection: string): QueryStyle => this.drivers.sqlStyle(connection);
  readonly learnQuotes = (connection: string) => this.drivers.learn(connection);
  /** What each editor tab keeps open while another one is shown. */
  readonly editors = new OpenEditors(this);
  /** The transactions of the SQL tabs: their warnings and the pending list. */
  readonly transactions = new SectionTransactions(this);
  /** What the SQL editor knows of each connection's schema. */
  readonly schema = new SchemaCache(this);
  /** The entity-relationship diagrams: their layouts and the saved ones (DB-20). */
  readonly diagrams = new SectionDiagrams(this);
  /** The dashboards of the servers: their layouts and their readings (DB-22). */
  readonly dashboards = new SectionDashboards(this);

  readonly connections = computed(() => this.state.documents().filter(isDbConnection));
  /** Saved SQL scripts. */
  readonly scripts = computed(() => this.state.documents().filter((d) => d.kind === 'sql-script'));
  /** SQL tabs that run their text as soon as they open («View data»). */
  readonly runOnOpen = signal<ReadonlySet<string>>(new Set());
  /** The transfer wizard open, and what it starts from (DB-17). */
  readonly transferRequest = signal<TransferRequest | undefined>(undefined);
  /** The search dialog is open (DB-18), and the table editor (DB-19). */
  readonly searching = signal(false);
  readonly structureRequest = signal<StructureRequest | undefined>(undefined);
  readonly folders = computed(() => dbFolders(this.connections()));
  readonly folderNames = computed(() =>
    this.folders()
      .map((group) => group.folder)
      .filter(Boolean),
  );
  readonly rows = computed(() =>
    navigatorRows({
      connections: this.connections(),
      folders: this.folders(),
      expanded: this.tree.expanded(),
      closedFolders: this.tree.closedFolders(),
      children: this.tree.children(),
      loading: this.tree.loading(),
      errors: this.tree.errors(),
      status: this.tree.status(),
      simple: this.simple(),
      text: this.text(),
      scripts: this.scripts(),
      diagrams: this.diagrams.saved(),
    }),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dashboards.closeAll());
    // The navigator as it was: open nodes and bookmarks come back, but nothing reconnects.
    const stored = untracked(() => this.state.databaseSession());
    if (stored) {
      this.tree.expanded.set(new Set(stored.expanded));
      this.bookmarks.set(stored.bookmarks);
      this.simple.set(stored.simple);
      this.active.set(stored.active);
      this.restoreTabs(stored.tabs, stored.drafts, stored.activeTab);
    }
    effect(() => {
      const session = {
        expanded: [...this.tree.expanded()],
        active: this.active(),
        bookmarks: [...this.bookmarks()],
        simple: this.simple(),
        tabs: [...this.tabs.tabs()],
        activeTab: this.tabs.activeId(),
        drafts: storedDrafts(this.tabs.drafts()),
        diagrams: { ...this.diagrams.layouts() },
        dashboards: { ...this.dashboards.layouts() },
      };
      untracked(() => this.state.databaseSession.set(session));
    });
  }

  /**
   * The editor tabs of a stored session, without results: a saved script that had not
   * changed reads its text again from its document; tabs of deleted connections stay closed.
   */
  private restoreTabs(
    tabs: Parameters<DbTabsStore['restore']>[0],
    drafts: Readonly<Record<string, SqlDraft>>,
    active: string,
  ) {
    const kept = tabs.filter((tab) => !tab.connection || !!this.connection(tab.connection));
    const script = (id: string) => {
      const found = this.scripts().find((document) => document.id === id);
      return found && readScript(found.value).sql;
    };
    this.tabs.restore(kept, restoredDrafts(drafts, script), active);
  }

  /** The runner of a SQL tab, created when the tab is first shown. */
  runner(tab: string) {
    return this.editors.runner(tab);
  }

  /** Closes an editor tab with what it had open: sessions and cursors. */
  closeTab(id: string) {
    this.editors.close(id);
    this.dashboards.close(id);
    this.tabs.close(id);
  }

  /** The driver (module) of a connection. */
  driverOf(connection: string) {
    return readDbConnection(this.connection(connection)?.value).driver;
  }

  /** Opens a SQL tab on a connection, with a text and on another database if asked. */
  newScript(connection: string, options: { text?: string; database?: string; run?: boolean } = {}) {
    if (!this.connection(connection)) return;
    this.active.set(connection);
    const tab = this.tabs.open(
      { kind: 'sql', connection, title: 'SQL' },
      {
        text: options.text ?? '',
        cursor: options.text?.length ?? 0,
        dirty: !!options.text,
        ...(options.database ? { database: options.database } : {}),
      },
    );
    if (options.run) this.runOnOpen.update((set) => new Set([...set, tab.id]));
  }

  /** Opens a saved script, or shows its tab when it is open. */
  openScript(id: string, cursor = 0) {
    const document = this.scripts().find((script) => script.id === id);
    if (!document) return;
    const value = readScript(document.value);
    this.tabs.open(
      { kind: 'sql', connection: value.connectionId, title: document.name },
      {
        text: value.sql,
        cursor,
        script: id,
        ...(value.database ? { database: value.database } : {}),
      },
    );
  }

  /** Opens the tab of an object of the tree. */
  openObject(row: NavigatorRow) {
    if (!row.connection || !row.path?.length) return;
    this.tabs.open({
      kind: 'object',
      connection: row.connection,
      title: row.label,
      path: row.path,
    });
  }

  /** The nodes along a path of the tree, as loaded. */
  nodesAlong(connection: string, path: readonly string[]): DbNode[] {
    const children = this.tree.children();
    return path.flatMap((name, depth) => {
      const parent = nodeKey(connection, path.slice(0, depth));
      const found = children.get(parent)?.find((node) => node.name === name);
      return found ? [found] : [];
    });
  }

  connection(id: string): WorkspaceDocument | undefined {
    return this.connections().find((document) => document.id === id);
  }
  typeOf(id: string): ConnectionType {
    const document = this.connection(id);
    return document ? connectionType(readDbConnection(document.value)) : 'development';
  }

  /**
   * Whether a module can run now. When it is missing or outdated, its download dialog asks
   * first; this resolves once it is installed or the person closes the dialog.
   */
  async ensure(driver: string): Promise<boolean> {
    const need = await this.modules.ensure(driver);
    if (need.ready) return true;
    return new Promise<boolean>((done) =>
      this.moduleWait.set({
        module: need.module,
        done: (installed) => {
          this.moduleWait.set(undefined);
          done(installed);
        },
      }),
    );
  }

  /** Opens the editor of a saved connection, or of a new one. */
  edit(connection?: WorkspaceDocument) {
    if (connection) this.active.set(connection.id);
    this.tabs.open({
      kind: 'connection',
      connection: connection?.id ?? '',
      title: connection?.name ?? 'New connection',
    });
  }

  /** Opens a bookmarked node: connects and opens the nodes that lead to it. */
  async reveal(bookmark: DbBookmark) {
    const connection = this.connection(bookmark.connection);
    if (!connection) return;
    this.active.set(connection.id);
    for (let depth = 0; depth < bookmark.path.length; depth++)
      await this.tree.expand(connection, bookmark.path.slice(0, depth));
    return nodeKey(connection.id, bookmark.path);
  }

  /** Bookmarks whose connection still exists. */
  readonly shownBookmarks = computed(() =>
    this.bookmarks().filter((bookmark) => !!this.connection(bookmark.connection)),
  );

  /** Whether a node is bookmarked. */
  isBookmarked(key: string) {
    return this.bookmarks().some((mark) => nodeKey(mark.connection, mark.path) === key);
  }

  /** The connection a row's key belongs to. */
  connectionOfKey(key: string) {
    return this.connection(keyPath(key).connection);
  }
}
