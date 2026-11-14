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
import { CodeEditor } from './code-editor';
import { DbResultTable } from './db-result-table';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { PanelTask } from './panel-task';
import { success } from './workspace-state';

/** What `db.describe` answers: properties and sections the interface draws as they come. */
interface ObjectDescription {
  kind: string;
  name: string;
  properties: { name: string; value: unknown }[];
  sections: { id: string; title: string; columns: string[]; rows: unknown[][] }[];
}

/**
 * The tab of an object of the tree, as DBeaver's object editor: its properties, a sub-tab
 * per section its driver describes (columns, constraints, indexes…) and its DDL. Data and
 * the structure editor come with DB-07 and DB-08.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor, DbResultTable],
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
  protected readonly part = signal('properties');
  protected readonly text = cellText;
  protected readonly node = computed(() => {
    const tab = this.tab();
    return this.section.nodesAlong(tab.connection, tab.path ?? []).at(-1);
  });
  protected readonly parts = computed(() => [
    'properties',
    ...(this.description()?.sections ?? []).map((section) => section.id),
    ...(this.node()?.actions.includes('ddl') ? ['ddl'] : []),
  ]);
  protected readonly shownSection = computed(() =>
    this.description()?.sections.find((section) => section.id === this.part()),
  );
  /** The columns of the section shown, as the result table takes them. */
  protected readonly sectionColumns = computed(() =>
    (this.shownSection()?.columns ?? []).map((name) => ({ name, typeName: '', kind: 'text' })),
  );

  constructor() {
    effect(() => {
      const tab = this.tab();
      untracked(() => void this.load(tab));
    });
  }

  protected partLabel(part: string) {
    if (part === 'properties') return 'Properties';
    if (part === 'ddl') return 'DDL';
    return this.description()?.sections.find((section) => section.id === part)?.title ?? part;
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
      this.ddl.set(
        this.node()?.actions.includes('ddl')
          ? await cases.navigator.ddl(workspace, session, tab.path ?? []).catch(() => '')
          : '',
      );
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
  protected viewData() {
    const tab = this.tab();
    const node = this.node();
    if (!node) return;
    void this.section.viewData({
      key: '',
      type: 'node',
      level: 1,
      label: node.label,
      connection: tab.connection,
      path: tab.path,
      node,
      expandable: false,
      expanded: false,
    });
  }
}
