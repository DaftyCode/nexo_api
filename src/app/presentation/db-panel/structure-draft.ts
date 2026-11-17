import { signal } from '@angular/core';
import { DdlPlan, TableModel, newTable, planScript, tableChanged } from '../../domain/db/structure';
import type { DbSection } from './section';

/** What the structure editor opens on: a table to edit or drop, or a folder to create in. */
export interface StructureRequest {
  connection: string;
  /** A table's path; for `create`, the path of the folder of tables. */
  path: string[];
  mode: 'edit' | 'create' | 'drop' | 'empty';
  /** The table's name, for the dialogs. */
  name: string;
}

/**
 * The structure of a table while it is edited (DB-19): the model read with `db.ddl.model`
 * (or a new one), the copy the person changes, the statements the driver writes for the
 * difference, and their run, on a session of the editor's own.
 */
export class StructureDraft {
  readonly original = signal<TableModel | undefined>(undefined);
  readonly table = signal<TableModel>(newTable(''));
  readonly types = signal<readonly string[]>([]);
  readonly plan = signal<DdlPlan | undefined>(undefined);
  /** The statements as the review shows them, which the person may edit. */
  readonly script = signal('');
  readonly busy = signal(false);
  /** The plan drops the table itself: its name is typed to run it. */
  readonly dropping = signal(false);
  readonly error = signal('');
  private session?: string;

  constructor(
    readonly section: DbSection,
    readonly connection: string,
    readonly path: readonly string[],
    readonly creating: boolean,
  ) {}

  private workspace() {
    return this.section.state.workspaceId();
  }
  private async open() {
    if (this.session) return this.session;
    const document = this.section.connection(this.connection);
    if (!document) throw new Error('The connection is no longer there');
    const driver = String((document.value as { driver?: string }).driver ?? '');
    if (!(await this.section.ensure(driver)))
      throw new Error('The module of the connection is not installed');
    const session = `structure:${this.connection}:${Date.now()}`;
    const cases = await this.section.cases();
    await cases.statements.open(this.workspace(), document, session, this.section.state.scopes(), {
      manual: false,
    });
    this.session = session;
    return session;
  }
  async close() {
    if (!this.session) return;
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
    this.session = undefined;
  }

  /** Reads the table (or, to create one, the types alone). */
  async load(name = '') {
    await this.guard(async () => {
      const cases = await this.section.cases();
      const session = await this.open();
      const read = await cases.structure.model(
        this.workspace(),
        session,
        this.creating ? [] : this.path,
      );
      this.types.set(read.types);
      if (this.creating) {
        // The schema of a folder of tables is the segment before it (none in SQLite).
        const schema = this.path.length >= 2 ? this.path[this.path.length - 2] : undefined;
        this.original.set(undefined);
        this.table.set(newTable(name, schema));
      } else {
        this.original.set(read.table);
        this.table.set(read.table);
      }
    });
  }

  changed() {
    return this.creating || tableChanged(this.original(), this.table());
  }
  revert() {
    const original = this.original();
    if (original) this.table.set(original);
    this.plan.set(undefined);
  }

  /** The statements of the change (or of dropping the table), for the review. */
  async review(drop = false, cascade = false) {
    this.dropping.set(drop);
    await this.guard(async () => {
      const cases = await this.section.cases();
      const session = await this.open();
      const plan = await cases.structure.plan(
        this.workspace(),
        session,
        this.creating ? undefined : this.original(),
        drop ? undefined : this.table(),
        cascade,
      );
      this.plan.set(plan);
      this.script.set(planScript(plan.statements));
    });
  }

  /** Runs the statements as the review left them; `true` when all of them ran. */
  async run(confirmName?: string): Promise<boolean> {
    const plan = this.plan();
    if (!plan) return false;
    const statements = this.script()
      .split(/;\s*\n\s*\n/)
      .map((statement) => statement.trim().replace(/;$/, ''))
      .filter(Boolean);
    let ran = false;
    await this.guard(async () => {
      const cases = await this.section.cases();
      const session = await this.open();
      // A rebuild drops the table it replaces: the change was read and confirmed whole.
      const name = this.dropping() ? confirmName : this.original()?.name;
      await cases.structure.run(this.workspace(), session, statements, {
        transactional: plan.transactional,
        ...(name ? { confirmName: name } : {}),
      });
      ran = true;
      this.plan.set(undefined);
      await this.refreshTree();
    });
    return ran;
  }

  /** Empties the table (`TRUNCATE`, or `DELETE` in SQLite), its name typed. */
  async empty(qualified: string, name: string) {
    let ran = false;
    await this.guard(async () => {
      const cases = await this.section.cases();
      const session = await this.open();
      const sqlite = this.section.sqlStyle(this.connection).name === 'sqlite';
      const sql = sqlite ? `DELETE FROM ${qualified}` : `TRUNCATE TABLE ${qualified}`;
      await cases.structure.run(this.workspace(), session, [sql], {
        transactional: false,
        confirmName: name,
      });
      ran = true;
    });
    return ran;
  }

  /** The tree shows the table as it is now. */
  private async refreshTree() {
    const document = this.section.connection(this.connection);
    if (!document) return;
    const folder = this.creating ? [...this.path] : this.path.slice(0, -1);
    this.section.schema.clear(this.connection);
    await this.section.tree.refresh(document, folder).catch(() => undefined);
  }

  private async guard(work: () => Promise<void>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await work();
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    } finally {
      this.busy.set(false);
    }
  }
}
