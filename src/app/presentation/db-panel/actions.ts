import { signal } from '@angular/core';
import { failureCode } from '../../application/ports';
import { filterAt, readDbConnection, withFilter } from '../../domain/db/connection';
import { NavigatorRow } from '../../domain/db/rows';
import { copiedName, toggleBookmark } from '../../domain/db/tree';
import { WorkspaceDocument } from '../../domain/models';
import type { DialogAnswer, DialogRequest } from '../mongo-dialog';
import { PanelTask } from '../panel-task';
import { Toast, named, success } from '../workspace-state';
import type { DbSection } from './section';

/** A dialog of the navigator and what its answer does. */
interface OpenDialog {
  request: DialogRequest;
  run: (answer: DialogAnswer) => Promise<Toast | undefined>;
  failure: string;
}

/**
 * What the navigator's menus and keys do with a connection or a node: connect, rename, move
 * to a folder, duplicate, delete after typing its name, filter its children, copy a name or
 * its DDL, bookmark it and refresh it.
 */
export class DbActions {
  readonly dialog = signal<OpenDialog | undefined>(undefined);
  readonly task: PanelTask;

  constructor(private readonly section: DbSection) {
    this.task = new PanelTask(section.state);
  }

  private document(row: NavigatorRow): WorkspaceDocument | undefined {
    return row.connection ? this.section.connection(row.connection) : undefined;
  }

  /** Saves a change of a connection; one changed elsewhere is saved over its latest version. */
  private async saveOver(
    document: WorkspaceDocument,
    change: (latest: WorkspaceDocument) => Promise<WorkspaceDocument>,
  ) {
    try {
      return await change(document);
    } catch (error) {
      if (failureCode(error) !== 'conflict') throw error;
      await this.section.state.refresh();
      const latest = this.section.connection(document.id);
      if (!latest) throw error;
      return change(latest);
    }
  }

  async toggle(row: NavigatorRow) {
    if (row.type === 'folder') return this.section.tree.toggleFolder(row.key);
    const document = this.document(row);
    if (!document || !row.expandable) return;
    if (row.expanded) this.section.tree.collapse(row.key);
    else await this.section.tree.expand(document, row.path ?? []);
  }

  async connect(row: NavigatorRow) {
    const document = this.document(row);
    if (document) await this.section.tree.expand(document, []);
  }
  async disconnect(row: NavigatorRow) {
    if (row.connection) await this.section.tree.disconnect(row.connection);
  }
  async reconnect(row: NavigatorRow) {
    const document = this.document(row);
    if (document) await this.section.tree.reconnect(document);
  }
  async refresh(row: NavigatorRow) {
    const document = this.document(row);
    if (document && row.type !== 'folder')
      await this.section.tree.refresh(document, row.path ?? []);
  }

  edit(row: NavigatorRow) {
    const document = this.document(row);
    if (document) this.section.edit(document);
  }

  duplicate(row: NavigatorRow) {
    const document = this.document(row);
    if (!document) return;
    void this.task.announce('The connection could not be duplicated', async () => {
      const cases = await this.section.cases();
      const name = `${document.name} (copy)`;
      const id = this.section.state.cases.files.id();
      const copy = await cases.connections.duplicate(
        this.section.state.workspaceId(),
        document,
        id,
        name,
      );
      await this.section.state.refresh();
      return named('Connection duplicated', copy.name);
    });
  }

  rename(row: NavigatorRow) {
    const document = this.document(row);
    if (!document || row.type !== 'connection') return;
    this.dialog.set({
      failure: 'The connection could not be renamed',
      request: {
        title: 'Rename connection',
        first: { label: 'Connection name', value: document.name },
        confirm: 'Rename',
      },
      run: async ({ first }) => {
        const name = first.trim();
        if (!name || name === document.name) return undefined;
        const cases = await this.section.cases();
        await this.saveOver(document, (latest) =>
          cases.connections.update(latest, name, readDbConnection(latest.value)),
        );
        await this.section.state.refresh();
        return named('Connection renamed', name);
      },
    });
  }

  moveTo(row: NavigatorRow) {
    const document = this.document(row);
    if (!document) return;
    this.dialog.set({
      failure: 'The connection could not be moved',
      request: {
        title: 'Move to folder',
        message: { key: 'db.move.message' },
        first: { label: 'Folder', value: readDbConnection(document.value).folder ?? '' },
        confirm: 'Move',
      },
      run: ({ first }) => this.move(document, first),
    });
  }

  /** Moves a connection to a folder; an empty folder takes it out of every folder. */
  async move(document: WorkspaceDocument, folder: string) {
    const cases = await this.section.cases();
    await this.saveOver(document, (latest) => cases.connections.moveTo(latest, folder));
    await this.section.state.refresh();
    return named('Connection moved', document.name);
  }

  remove(row: NavigatorRow) {
    const document = this.document(row);
    if (!document || row.type !== 'connection') return;
    this.dialog.set({
      failure: 'The connection could not be deleted',
      request: {
        title: 'Delete connection',
        message: { key: 'db.delete.message', params: { v0: document.name } },
        confirmName: document.name,
        confirm: 'Delete',
        danger: true,
      },
      run: async () => {
        await this.section.tree.disconnect(document.id);
        const cases = await this.section.cases();
        await cases.connections.remove(document, this.section.connections());
        this.section.tabs.closeConnection(document.id);
        this.section.bookmarks.update((marks) =>
          marks.filter((mark) => mark.connection !== document.id),
        );
        await this.section.state.refresh();
        return named('Connection deleted', document.name);
      },
    });
  }

  /** The include and exclude patterns of a node's children, kept in the connection. */
  filter(row: NavigatorRow) {
    const document = this.document(row);
    if (!document || !row.expandable || row.type === 'folder') return;
    const path = row.path ?? [];
    const current = filterAt(readDbConnection(document.value), path);
    this.dialog.set({
      failure: 'The filter could not be saved',
      request: {
        title: 'Filter objects',
        message: { key: 'db.filter.message', params: { v0: row.label } },
        first: { label: 'Show only names like', value: current?.include ?? '' },
        second: { label: 'Hide names like', value: current?.exclude ?? '' },
        confirm: 'Apply',
      },
      run: async ({ first, second }) => {
        const cases = await this.section.cases();
        await this.saveOver(document, (latest) =>
          cases.connections.setFilters(
            latest,
            withFilter(readDbConnection(latest.value), path, first, second),
          ),
        );
        await this.section.state.refresh();
        return success('Filter saved');
      },
    });
  }

  /** Answers the open dialog. */
  answer(answer: DialogAnswer) {
    const dialog = this.dialog();
    if (!dialog) return;
    this.dialog.set(undefined);
    void this.task.announce(dialog.failure, () => dialog.run(answer));
  }

  copyName(row: NavigatorRow) {
    if (!row.node || !row.connection) return;
    const connection = row.connection;
    const node = row.node;
    void this.task.run(async () => {
      await this.section.learnQuotes(connection).catch(() => undefined);
      await this.copy(copiedName(node, this.section.quoteStyle(connection)));
    });
  }

  copyDdl(row: NavigatorRow) {
    if (!row.connection || !row.path) return;
    const { connection, path } = row;
    void this.task.run(async () => {
      const cases = await this.section.cases();
      const sql = await cases.navigator.ddl(
        this.section.state.workspaceId(),
        `tree:${connection}`,
        path,
      );
      await this.copy(sql);
    });
  }

  private async copy(text: string) {
    await globalThis.navigator?.clipboard?.writeText(text);
    this.section.state.tell(success('Copied to the clipboard'));
  }

  bookmark(row: NavigatorRow) {
    if (!row.connection || row.type === 'folder') return;
    this.section.bookmarks.update((marks) =>
      toggleBookmark(marks, {
        connection: row.connection ?? '',
        path: row.path ?? [],
        label: row.label,
        kind: row.node?.kind ?? 'connection',
      }),
    );
  }
}
