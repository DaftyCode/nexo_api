import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { treeSession } from '../application/database-use-cases';
import { cellText } from '../domain/db/results';
import { ForeignKey, foreignKeys } from '../domain/db/table-query';
import { CodeEditor } from './code-editor';
import { DataGrid } from './data-grid/data-grid';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { DbTableData } from './db-table-data';
import { PanelTask } from './panel-task';
import { success } from './workspace-state';

/** What `db.describe` answers: properties and sections the interface draws as they come. */
interface ObjectDescription {
  kind: string;
  name: string;
  properties: { name: string; value: unknown }[];
  sections: { id: string; title: string; columns: string[]; rows: unknown[][] }[];
}

/** The properties shown in the header, when the driver gives them. */
const HEADER = ['Kind', 'Owner', 'Estimated rows', 'Size', 'Comment'];
/** The sections whose rows lead to another table, and where their ends are. */
const KEYS: Record<string, { schema: string; table: string }> = {
  'foreign-keys': { schema: 'Referenced schema', table: 'Referenced table' },
  references: { schema: 'Schema', table: 'Table name' },
};

/**
 * The tab of an object of the tree, as DBeaver's object editor: a header with its main
 * properties; its properties, a sub-tab per section its driver describes (columns, keys,
 * indexes…, sortable and filtered as grids); its data from the server for tables and views;
 * and its DDL. A key leads to the table it points to, or to the one that points to it.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor, DataGrid, DbTableData],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-object-tab',
  templateUrl: './db-object-tab.html',
  styleUrl: './db-object-tab.scss',
})
export class DbObjectTab {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly description = signal<ObjectDescription | undefined>(undefined);
  protected readonly ddl = signal('');
  protected readonly text = cellText;
  protected readonly follow = [{ id: 'follow', label: 'Open the related table' }];
  private sectionRow = 0;
  protected readonly node = computed(() => {
    const tab = this.tab();
    return this.section.nodesAlong(tab.connection, tab.path ?? []).at(-1);
  });
  /** Tables and views have rows to show. */
  protected readonly relation = computed(() => {
    const kind = this.node()?.kind ?? this.description()?.kind ?? '';
    return kind === 'table' || kind === 'view' || !!this.node()?.actions.includes('data');
  });
  protected readonly header = computed(() =>
    HEADER.flatMap((name) => {
      const found = this.description()?.properties.find((property) => property.name === name);
      const value = found ? cellText(found.value) : '';
      return found && value && value !== 'NULL' ? [{ name, value }] : [];
    }),
  );
  /**
   * The view shown, kept in the tab: a table or a view opens on its data, as DBeaver does when
   * its default page is «Data»; any other object on its properties.
   */
  protected readonly part = computed(
    () => this.tab().part ?? (this.relation() ? 'data' : 'properties'),
  );
  protected readonly parts = computed(() => [
    'properties',
    ...(this.relation() ? ['data'] : []),
    ...(this.description()?.sections ?? []).map((section) => section.id),
    ...(this.ddl() ? ['ddl'] : []),
  ]);
  protected readonly shownSection = computed(() =>
    this.description()?.sections.find((section) => section.id === this.part()),
  );
  /** The columns of the section shown, as the grid takes them. */
  protected readonly sectionColumns = computed(() =>
    (this.shownSection()?.columns ?? []).map((name) => ({ name, typeName: '', kind: 'text' })),
  );
  protected readonly parents = computed(() => this.keys('foreign-keys'));
  protected readonly children = computed(() => this.keys('references'));

  /** The object the tab shows: its filter and order change without describing it again. */
  private readonly object = computed(() => {
    const { connection, path } = this.tab();
    return `${connection}\n${(path ?? []).join('\n')}`;
  });

  constructor() {
    effect(() => {
      this.object();
      untracked(() => void this.load());
    });
  }

  private keys(id: string): ForeignKey[] {
    const section = this.description()?.sections.find((candidate) => candidate.id === id);
    return foreignKeys(section, KEYS[id], cellText);
  }

  protected partLabel(part: string) {
    if (part === 'properties') return 'Properties';
    if (part === 'data') return 'Data';
    if (part === 'ddl') return 'DDL';
    return this.description()?.sections.find((section) => section.id === part)?.title ?? part;
  }
  /** Shows a view and keeps it in the tab; the view shown stays as it is (its WHERE text too). */
  protected show(part: string) {
    if (part !== this.part()) this.section.tabs.update(this.tab().id, { part });
  }
  protected followsKeys() {
    return this.part() in KEYS;
  }

  /** Describes the object on the navigator's session, connecting it first if needed. */
  protected async load(tab = this.tab()) {
    const connection = this.section.connection(tab.connection);
    if (!connection || !tab.path) return;
    await this.task.run(async () => {
      if (this.section.tree.status()[connection.id] !== 'connected') {
        if (!(await this.section.tree.connect(connection))) throw new Error('db.object.offline');
      }
      const cases = await this.section.cases();
      const workspace = this.section.state.workspaceId();
      const session = treeSession(connection.id);
      this.description.set(await cases.navigator.describe(workspace, session, tab.path ?? []));
      const node = this.node();
      this.ddl.set(
        !node || node.actions.includes('ddl')
          ? await cases.navigator.ddl(workspace, session, tab.path ?? []).catch(() => '')
          : '',
      );
    });
  }

  protected rowChanged(row: number) {
    this.sectionRow = row;
  }

  /** Opens the table a key of the section shown leads to. */
  protected followKey() {
    const keys = this.part() === 'foreign-keys' ? this.parents() : this.children();
    const key = keys[this.sectionRow];
    const tab = this.tab();
    const path = tab.path ?? [];
    if (!key || path.length < 3) return;
    const target = [...path.slice(0, -3), key.schema || path.at(-3)!, path.at(-2)!, key.table];
    this.section.tabs.open({
      kind: 'object',
      connection: tab.connection,
      title: key.table,
      path: target,
    });
  }

  protected copyDdl() {
    void this.task.run(async () => {
      await globalThis.navigator?.clipboard?.writeText(this.ddl());
      this.section.state.tell(success('Copied to the clipboard'));
    });
  }
  protected openInScript() {
    this.section.newScript(this.tab().connection, { text: this.ddl() });
  }
}
