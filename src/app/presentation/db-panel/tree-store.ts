import { signal } from '@angular/core';
import type { DatabaseUseCases, DbServerInfo } from '../../application/database-use-cases';
import { treeSession } from '../../application/database-use-cases';
import { readDbConnection } from '../../domain/db/connection';
import { ConnectionStatus, DbNode, nodeKey } from '../../domain/db/tree';
import { WorkspaceDocument } from '../../domain/models';
import { VariableScopes } from '../../domain/variables';

/** What the tree needs from the section around it. */
export interface TreeContext {
  cases: () => Promise<DatabaseUseCases>;
  workspace: () => string;
  scopes: () => VariableScopes;
  /** Whether the module of a driver can run, after offering to download it. */
  ensure: (driver: string) => Promise<boolean>;
  describe: (error: unknown) => string;
}

const without = <T>(set: ReadonlySet<T>, item: T) => new Set([...set].filter((x) => x !== item));
const withItem = <T>(set: ReadonlySet<T>, item: T) => new Set([...set, item]);

/**
 * The navigator's tree: a session per connection, opened when the connection is expanded, and
 * each node's children asked when it is opened and kept until it is refreshed (F5).
 */
export class DbTreeStore {
  readonly status = signal<Record<string, ConnectionStatus>>({});
  readonly servers = signal<Record<string, DbServerInfo>>({});
  readonly children = signal<ReadonlyMap<string, readonly DbNode[]>>(new Map());
  readonly loading = signal<ReadonlySet<string>>(new Set());
  readonly errors = signal<ReadonlyMap<string, string>>(new Map());
  /** Open nodes, kept in the workspace session; connections among them only once connected. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly closedFolders = signal<ReadonlySet<string>>(new Set());

  constructor(private readonly context: TreeContext) {}

  private setStatus(connection: string, status: ConnectionStatus) {
    this.status.update((all) => ({ ...all, [connection]: status }));
  }
  private setError(key: string, message: string | undefined) {
    this.errors.update((all) => {
      const next = new Map(all);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  }

  /** Opens the session of a connection's tree; says why in the tree when it cannot. */
  async connect(connection: WorkspaceDocument): Promise<boolean> {
    if (this.status()[connection.id] === 'connecting') return false;
    const key = nodeKey(connection.id, []);
    this.setStatus(connection.id, 'connecting');
    this.setError(key, undefined);
    try {
      const driver = readDbConnection(connection.value).driver;
      if (!(await this.context.ensure(driver))) {
        this.setStatus(connection.id, 'disconnected');
        return false;
      }
      const cases = await this.context.cases();
      const server = await cases.navigator.connect(
        this.context.workspace(),
        connection,
        treeSession(connection.id),
        this.context.scopes(),
      );
      this.servers.update((all) => ({ ...all, [connection.id]: server }));
      this.setStatus(connection.id, 'connected');
      return true;
    } catch (error) {
      this.setStatus(connection.id, 'error');
      this.setError(key, this.context.describe(error));
      return false;
    }
  }

  /** Closes the session and forgets what was loaded; the open nodes stay for next time. */
  async disconnect(connection: string) {
    this.forget(connection);
    this.setStatus(connection, 'disconnected');
    try {
      const cases = await this.context.cases();
      await cases.navigator.disconnect(this.context.workspace(), treeSession(connection));
    } catch {
      // A session that is gone is already closed.
    }
  }

  async reconnect(connection: WorkspaceDocument) {
    await this.disconnect(connection.id);
    await this.expand(connection, []);
  }

  /** Drops what was loaded of a connection. */
  forget(connection: string) {
    const prefix = nodeKey(connection, []);
    const inside = (key: string) => key === prefix || key.startsWith(`${prefix}/`);
    this.children.update((all) => new Map([...all].filter(([key]) => !inside(key))));
    this.errors.update((all) => new Map([...all].filter(([key]) => !inside(key))));
  }

  /** Opens a node: connects first when it is the connection, and loads its children once. */
  async expand(connection: WorkspaceDocument, path: readonly string[]) {
    const key = nodeKey(connection.id, path);
    if (!path.length && this.status()[connection.id] !== 'connected') {
      if (!(await this.connect(connection))) return;
    }
    this.expanded.update((set) => withItem(set, key));
    if (!this.children().has(key)) await this.load(connection, path);
  }

  collapse(key: string) {
    this.expanded.update((set) => without(set, key));
  }

  toggleFolder(key: string) {
    this.closedFolders.update((set) => (set.has(key) ? without(set, key) : withItem(set, key)));
  }

  /** Loads a node's children, and those of its children that were open (a restored session). */
  async load(connection: WorkspaceDocument, path: readonly string[]) {
    const key = nodeKey(connection.id, path);
    this.loading.update((set) => withItem(set, key));
    this.setError(key, undefined);
    let nodes: DbNode[] = [];
    try {
      const cases = await this.context.cases();
      nodes = await cases.navigator.tree(
        this.context.workspace(),
        treeSession(connection.id),
        path,
      );
      this.children.update((all) => new Map(all).set(key, nodes));
    } catch (error) {
      this.setError(key, this.context.describe(error));
    } finally {
      this.loading.update((set) => without(set, key));
    }
    const open = this.expanded();
    await Promise.all(
      nodes
        .filter(
          (node) => node.hasChildren && open.has(nodeKey(connection.id, [...path, node.name])),
        )
        .map((node) => this.load(connection, [...path, node.name])),
    );
  }

  /** Asks a node's children again (F5), and those of the open nodes under it. */
  async refresh(connection: WorkspaceDocument, path: readonly string[]) {
    if (this.status()[connection.id] !== 'connected') return this.expand(connection, path);
    const key = nodeKey(connection.id, path);
    const inside = (other: string) => other === key || other.startsWith(`${key}/`);
    this.children.update((all) => new Map([...all].filter(([other]) => !inside(other))));
    this.expanded.update((set) => withItem(set, key));
    await this.load(connection, path);
  }

  /** The connections whose session is open. */
  connected(): string[] {
    return Object.entries(this.status())
      .filter(([, status]) => status === 'connected')
      .map(([id]) => id);
  }
}
