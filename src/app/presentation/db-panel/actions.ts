import { signal } from '@angular/core';
import { Generated } from '../../domain/db/sql-generate';
import { generateSql } from './generate';
import { openTransfer } from './transfer-request';
import { openStructure } from './structure-request';
import { copyDdl, copyName, newObject, refreshView, viewData } from './node-scripts';
import { failureCode } from '../../application/ports';
import { filterAt, readDbConnection, withFilter } from '../../domain/db/connection';
import { NavigatorRow } from '../../domain/db/rows';
import { toggleBookmark } from '../../domain/db/tree';
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
    if (['folder', 'scripts', 'script-group', 'diagrams'].includes(row.type))
      return this.section.tree.toggleFolder(row.key);
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
    if (document && (row.type === 'connection' || row.type === 'node')) {
      this.section.schema.clear(document.id);
      await this.section.tree.refresh(document, row.path ?? []);
    }
  }

  /** Opens what a row is: a saved script, or the tab of an object. */
  open(row: NavigatorRow) {
    if (row.type === 'script' && row.script) return this.section.openScript(row.script);
    if (row.type === 'diagram' && row.diagram) return this.section.diagrams.openId(row.diagram);
    if (row.type === 'node' && row.node?.actions.includes('open')) this.section.openObject(row);
  }
  viewData = (row: NavigatorRow) => viewData(this.section, row);
  viewDiagram = (row: NavigatorRow) => this.section.diagrams.view(row);
  newDiagram = (row: NavigatorRow) =>
    this.task.announce('The diagram could not be created', () =>
      this.section.diagrams.create(row.connection ?? ''),
    );
  deleteDiagram = (row: NavigatorRow) =>
    this.task.announce('The diagram could not be deleted', () =>
      this.section.diagrams.remove(row.diagram ?? ''),
    );
  newScript(row: NavigatorRow) {
    if (row.connection) this.section.newScript(row.connection);
  }
  console(row: NavigatorRow) {
    if (row.connection)
      this.section.tabs.open({ kind: 'console', connection: row.connection, title: 'Console' });
  }
  generateSelect = (row: NavigatorRow) => this.generate(row, 'select');
  generateInsert = (row: NavigatorRow) => this.generate(row, 'insert');
  generateUpdate = (row: NavigatorRow) => this.generate(row, 'update');
  generateDelete = (row: NavigatorRow) => this.generate(row, 'delete');
  generateMerge = (row: NavigatorRow) => this.generate(row, 'merge');
  exportData = (row: NavigatorRow) => openTransfer(this.section, row, 'export');
  importData = (row: NavigatorRow) => openTransfer(this.section, row, 'import');
  copyData = (row: NavigatorRow) => openTransfer(this.section, row, 'copy');
  editStructure = (row: NavigatorRow) => openStructure(this.section, row, 'edit');
  dropTable = (row: NavigatorRow) => openStructure(this.section, row, 'drop');
  emptyTable = (row: NavigatorRow) => openStructure(this.section, row, 'empty');
  newTable = (row: NavigatorRow) => openStructure(this.section, row, 'create');
  private generate(row: NavigatorRow, kind: Generated) {
    return this.task.announce('The SQL could not be generated', async () => {
      await generateSql(this.section, row, kind);
      return undefined;
    });
  }
  deleteScript(row: NavigatorRow) {
    const document = this.section.scripts().find((script) => script.id === row.script);
    if (!document || !this.section.state.confirm('Delete this script?')) return;
    void this.task.announce('The script could not be deleted', async () => {
      await (await this.section.cases()).statements.removeScript(document);
      await this.section.state.refresh();
      return named('Script deleted', document.name);
    });
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
        for (const tab of this.section.tabs.tabs())
          if (tab.connection === document.id) this.section.closeTab(tab.id);
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

  copyName = (row: NavigatorRow) => copyName(this.section, this.task, row);
  copyDdl = (row: NavigatorRow) => copyDdl(this.section, this.task, row);
  newObject = (row: NavigatorRow) => void newObject(this.section, row);
  refreshView = (row: NavigatorRow) => void refreshView(this.section, row);

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
