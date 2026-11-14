import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { DatabaseUseCases } from '../../application/database-use-cases';
import { DATABASES, MODULES } from '../../composition/providers';
import {
  ConnectionType,
  connectionType,
  dbFolders,
  isDbConnection,
  readDbConnection,
} from '../../domain/db/connection';
import { navigatorRows } from '../../domain/db/rows';
import { DbBookmark, QuoteStyle, keyPath, nodeKey } from '../../domain/db/tree';
import { ModuleSummary } from '../../domain/modules';
import { WorkspaceDocument } from '../../domain/models';
import { WorkspaceState } from '../workspace-state';
import { DbTabsStore } from './tabs-store';
import { DbTreeStore } from './tree-store';

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
  readonly cases = (): Promise<DatabaseUseCases> => this.loader();
  /** The module whose download dialog is open, if any. */
  readonly moduleWait = signal<ModuleWait | undefined>(undefined);
  readonly tree = new DbTreeStore({
    cases: this.cases,
    workspace: () => this.state.workspaceId(),
    scopes: () => this.state.scopes(),
    ensure: (driver) => this.ensure(driver),
    describe: (error) => this.state.describe(error),
  });
  readonly tabs = new DbTabsStore(() => this.state.cases.files.id());
  readonly bookmarks = signal<readonly DbBookmark[]>([]);
  /** The simple view hides system objects and administration folders. */
  readonly simple = signal(true);
  readonly text = signal('');
  /** The connection last chosen in the navigator. */
  readonly active = signal('');
  private readonly quotes = signal<Readonly<Record<string, QuoteStyle>>>({});

  readonly connections = computed(() => this.state.documents().filter(isDbConnection));
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
    }),
  );

  constructor() {
    // The navigator as it was: open nodes and bookmarks come back, but nothing reconnects.
    const stored = untracked(() => this.state.databaseSession());
    if (stored) {
      this.tree.expanded.set(new Set(stored.expanded));
      this.bookmarks.set(stored.bookmarks);
      this.simple.set(stored.simple);
      this.active.set(stored.active);
    }
    effect(() => {
      const session = {
        expanded: [...this.tree.expanded()],
        active: this.active(),
        bookmarks: [...this.bookmarks()],
        simple: this.simple(),
      };
      untracked(() => this.state.databaseSession.set(session));
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

  /** How the driver of a connection quotes names; plain double quotes until it says. */
  quoteStyle(connection: string): QuoteStyle {
    const driver = readDbConnection(this.connection(connection)?.value).driver;
    return this.quotes()[driver] ?? { quoteOpen: '"', quoteClose: '"' };
  }
  /** Asks the driver of a connection how it quotes names, once. */
  async learnQuotes(connection: string) {
    const driver = readDbConnection(this.connection(connection)?.value).driver;
    if (!driver || this.quotes()[driver]) return;
    const hello = await (await this.cases()).navigator.hello(this.state.workspaceId(), driver);
    this.quotes.update((all) => ({ ...all, [driver]: hello.dialect }));
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
