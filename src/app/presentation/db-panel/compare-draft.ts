import { computed, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { treeSession } from '../../application/database-use-cases';
import type {
  CompareCandidate,
  CompareSideRef,
} from '../../application/database-use-cases/compare';
import {
  CompareKind,
  ComparedObject,
  CompareWarning,
  DataComparison,
  DefinitionLine,
  SchemaComparison,
  definitionLines,
  namesOf,
  tableOf,
} from '../../domain/db/compare';
import { readDbConnection } from '../../domain/db/connection';
import { success } from '../workspace-state';
import type { DbSection } from './section';
import type { DbTab } from './tabs-store';

export interface CompareModel {
  target: string;
  /** The path of the target, as JSON. */
  targetPath: string;
  ignoreComments: boolean;
  ignoreColumnOrder: boolean;
  ignoreConstraintNames: boolean;
  key: string;
  ignore: string;
  filter: string;
  drop: boolean;
  remove: boolean;
  confirmName: string;
}

/**
 * What the «Compare» tab of a schema, database or table holds (DB-24): the target chosen, the
 * comparison of structure or of data, the script that makes the target like the source, and
 * the sessions of its own it opens on both connections (closed with the tab).
 */
export class CompareDraft {
  readonly mode = signal<'structure' | 'data'>('structure');
  readonly model = signal<CompareModel>({
    target: '',
    targetPath: '',
    ignoreComments: false,
    ignoreColumnOrder: true,
    ignoreConstraintNames: true,
    key: '',
    ignore: '',
    filter: '',
    drop: false,
    remove: false,
    confirmName: '',
  });
  readonly fields = form(this.model);
  readonly candidates = signal<CompareCandidate[]>([]);
  readonly structure = signal<SchemaComparison | undefined>(undefined);
  readonly data = signal<DataComparison | undefined>(undefined);
  readonly chosen = signal<ComparedObject | undefined>(undefined);
  readonly definitions = signal<[DefinitionLine[], DefinitionLine[]] | undefined>(undefined);
  readonly script = signal('');
  readonly warnings = signal<CompareWarning[]>([]);
  readonly running = signal(false);
  readonly kind: CompareKind;
  private readonly sessions = new Map<string, string>();
  private readonly statement = `compare-${Date.now()}`;

  readonly targetDocument = computed(() => this.section.connection(this.model().target));
  readonly targetTable = computed(() => {
    const path = this.targetPath();
    return path ? tableOf(path).table : '';
  });
  /** The target is for production: synchronizing asks once more. */
  readonly production = computed(
    () => readDbConnection(this.targetDocument()?.value).type === 'production',
  );

  constructor(
    private readonly section: DbSection,
    readonly tab: DbTab,
  ) {
    this.kind = tab.part === 'table' ? 'table' : 'schema';
  }

  private workspace() {
    return this.section.state.workspaceId();
  }

  targetPath(): string[] | undefined {
    const text = this.model().targetPath;
    if (!text) return undefined;
    return JSON.parse(text) as string[];
  }

  /** The schemas and databases, or the tables, of the target connection. */
  async loadCandidates() {
    const target = this.model().target;
    this.candidates.set([]);
    const document = this.section.connection(target);
    if (!document) return;
    const driver = readDbConnection(document.value).driver;
    if (driver === 'sqlite' && this.kind === 'schema') {
      this.candidates.set([{ path: [], label: document.name }]);
      return;
    }
    if (
      this.section.tree.status()[target] !== 'connected' &&
      !(await this.section.tree.connect(document))
    )
      throw new Error('db.object.offline');
    const cases = await this.section.cases();
    this.candidates.set(
      await cases.compare.candidates(this.workspace(), treeSession(target), this.kind),
    );
  }

  /** A session of the comparison's own on a connection. */
  private async session(role: string, connection: string): Promise<string> {
    const known = this.sessions.get(`${role}:${connection}`);
    if (known) return known;
    const document = this.section.connection(connection);
    if (!document) throw new Error('The connection is no longer there');
    if (!(await this.section.ensure(readDbConnection(document.value).driver)))
      throw new Error('The module of the connection is not installed');
    const session = `compare-${role}:${connection}:${Date.now()}`;
    const cases = await this.section.cases();
    await cases.statements.open(this.workspace(), document, session, this.section.state.scopes(), {
      manual: false,
    });
    this.sessions.set(`${role}:${connection}`, session);
    return session;
  }

  /** Both sides, with their sessions open. */
  private async sides(): Promise<[CompareSideRef, CompareSideRef]> {
    const path = this.targetPath();
    if (!this.model().target || !path) throw new Error('Choose what to compare it with');
    const table = this.kind === 'table';
    return [
      {
        session: await this.session('source', this.tab.connection),
        path: this.tab.path ?? [],
        table,
      },
      { session: await this.session('target', this.model().target), path, table },
    ];
  }

  private options() {
    const m = this.model();
    return {
      structure: {
        ignoreComments: m.ignoreComments,
        ignoreColumnOrder: m.ignoreColumnOrder,
        ignoreConstraintNames: m.ignoreConstraintNames,
      },
      data: { key: namesOf(m.key), ignore: namesOf(m.ignore), filter: m.filter },
    };
  }

  async compare() {
    this.running.set(true);
    this.script.set('');
    this.warnings.set([]);
    this.chosen.set(undefined);
    this.definitions.set(undefined);
    try {
      const [source, target] = await this.sides();
      const cases = await this.section.cases();
      if (this.mode() === 'structure')
        this.structure.set(
          await cases.compare.structure(this.workspace(), source, target, this.options().structure),
        );
      else
        this.data.set(
          await cases.compare.data(
            this.workspace(),
            source,
            target,
            this.options().data,
            this.statement,
          ),
        );
    } finally {
      this.running.set(false);
    }
  }

  /** Shows the definitions of an object on both sides, the lines that differ marked. */
  async show(object: ComparedObject) {
    this.chosen.set(object);
    this.definitions.set(undefined);
    const cases = await this.section.cases();
    const read = async (role: 'source' | 'target', path?: string[] | null) => {
      if (!path) return '';
      const connection = role === 'source' ? this.tab.connection : this.model().target;
      return cases.navigator.ddl(this.workspace(), await this.session(role, connection), path);
    };
    const [source, target] = await Promise.all([
      object.sourceDefinition ?? read('source', object.sourcePath),
      object.targetDefinition ?? read('target', object.targetPath),
    ]);
    this.definitions.set(definitionLines(source, target));
  }

  /** The script that makes the target like the source: DDL, or the rows' statements. */
  async makeScript() {
    const [source, target] = await this.sides();
    const cases = await this.section.cases();
    if (this.mode() === 'structure') {
      const made = await cases.compare.script(
        this.workspace(),
        source,
        target,
        this.options().structure,
        this.model().drop,
      );
      this.script.set(
        made.statements.map((statement) => statement.replace(/;?\s*$/, ';')).join('\n'),
      );
      this.warnings.set(made.warnings);
    } else {
      const statements = await cases.compare.dataScript(
        this.workspace(),
        source,
        target,
        this.options().data,
        this.statement,
        this.model().remove,
      );
      this.script.set(statements.join('\n'));
      this.warnings.set([]);
    }
  }

  /** Opens the script in a SQL tab of the target, to read, change, save or run it. */
  openScript() {
    this.section.newScript(this.model().target, { text: this.script() });
  }

  /** Makes the target's rows like the source's, after the table's name is typed. */
  async sync() {
    const name = this.targetTable();
    if (this.model().confirmName.trim() !== name)
      throw new Error('Type the name of the target table to change its rows');
    const document = this.targetDocument();
    if (
      this.production() &&
      !this.section.state.confirm('db.compare.confirmProduction', { v0: document?.name ?? '' })
    )
      return undefined;
    const [source, target] = await this.sides();
    const cases = await this.section.cases();
    const written = await cases.compare.sync(
      this.workspace(),
      source,
      target,
      this.options().data,
      this.statement,
      { remove: this.model().remove, name, production: this.production() },
    );
    this.model.update((m) => ({ ...m, confirmName: '' }));
    await this.compare();
    return success('Rows synchronized', 'db.compare.synced', {
      v0: String(written.inserted),
      v1: String(written.updated),
      v2: String(written.deleted),
    });
  }

  async cancel() {
    const cases = await this.section.cases();
    await cases.compare.cancel(this.workspace(), [...this.sessions.values()], this.statement);
  }

  /** Closes the sessions it opened. */
  async close() {
    const cases = await this.section.cases();
    for (const session of this.sessions.values())
      await cases.statements.close(this.workspace(), session).catch(() => undefined);
    this.sessions.clear();
  }
}
