import { computed, inject } from '@angular/core';
import { MONGO } from '../../composition/providers';
import type { DbNode } from '../../domain/db/tree';
import { WorkspaceDocument } from '../../domain/models';
import { isMongoConnection } from '../../domain/mongo';
import type { DbSection } from './section';

/** The MongoDB module: what opening one of its connections downloads, when missing. */
export const MONGO_MODULE = 'mongodb';

/**
 * MongoDB in the section of the databases (DB-39): its connections, in the same tree as the
 * SQL ones, with their databases and collections from its use cases, and the explorer of a
 * connection in its tab, on a collection or on its shell.
 */
export class SectionMongo {
  readonly cases = inject(MONGO);
  readonly connections = computed(() => this.section.state.documents().filter(isMongoConnection));

  constructor(private readonly section: DbSection) {}

  connection(id: string): WorkspaceDocument | undefined {
    return this.connections().find((document) => document.id === id);
  }

  /** The databases of a connection, or the collections of one of them. */
  async tree(connection: WorkspaceDocument, path: readonly string[]): Promise<DbNode[]> {
    const state = this.section.state;
    return (await this.cases()).connections.tree(
      state.workspaceId(),
      connection,
      state.scopes(),
      path,
    );
  }

  /**
   * Opens the explorer of a connection in its tab (one per connection) once its module is
   * ready: on a collection, or on its shell.
   */
  async open(connection: string, focus: { path?: string[]; shell?: boolean } = {}) {
    const document = this.connection(connection);
    if (!document || !(await this.section.ensure(MONGO_MODULE))) return;
    this.section.active.set(connection);
    const tabs = this.section.tabs;
    const tab = tabs.open({ kind: 'mongo', connection, title: document.name });
    tabs.update(tab.id, {
      ...(focus.path ? { path: focus.path } : {}),
      part: focus.shell ? 'shell' : undefined,
    });
  }
}
