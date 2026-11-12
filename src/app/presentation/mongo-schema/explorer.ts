import { Injector, runInInjectionContext, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import type { ValidationAction, ValidationLevel } from '../../application/mongo-use-cases';
import type { TransferFilesPort } from '../../application/ports';
import { shellToExtendedJson } from '../../domain/mongo-query';
import {
  FieldSchema,
  SchemaReport,
  schemaCsv,
  schemaMarkdown,
  valueFilter,
} from '../../domain/mongo-schema';
import type { MongoExplorer } from '../mongo-explorer';
import { named } from '../workspace-state';

/** What the Schema tab edits. */
export interface SchemaModel {
  /** Documents sampled. */
  size: string;
  /** Sample the documents of the query of the Documents tab, not the whole collection. */
  useQuery: boolean;
  /** The validation rules, as JSON or in the shell syntax. */
  validator: string;
  level: ValidationLevel;
  action: ValidationAction;
  /** The collection's name, repeated to replace its rules. */
  confirm: string;
}

/** What the schema is exported as. */
export type SchemaExport = 'csv' | 'markdown' | 'jsonSchema' | 'validator';

const EXPORTS: Record<SchemaExport, { suffix: string; extension: string; type: string }> = {
  csv: { suffix: '-schema.csv', extension: 'csv', type: 'text/csv' },
  markdown: { suffix: '-schema.md', extension: 'md', type: 'text/markdown' },
  jsonSchema: { suffix: '.schema.json', extension: 'json', type: 'application/schema+json' },
  validator: { suffix: '-validator.json', extension: 'json', type: 'application/json' },
};

/**
 * The Schema tab: a random sample of the collection (or of the query's documents) analysed
 * by the engine, its fields opened to their values, exported, and turned into validation
 * rules for the collection.
 */
export class SchemaExplorer {
  readonly model = signal<SchemaModel>({
    size: '1000',
    useQuery: false,
    validator: '',
    level: 'strict',
    action: 'error',
    confirm: '',
  });
  readonly fields;
  readonly report = signal<SchemaReport | undefined>(undefined);
  readonly running = signal<string | undefined>(undefined);
  /** Fields whose values and ranges are shown. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** What the last change of the validation rules did, as a message key. */
  readonly applied = signal('');
  readonly problem = signal('');

  constructor(
    private readonly explorer: MongoExplorer,
    injector: Injector,
    private readonly files: TransferFilesPort,
  ) {
    this.fields = runInInjectionContext(injector, () => form(this.model));
  }

  async analyze() {
    const { explorer } = this;
    const target = explorer.target();
    if (!target || this.running()) return;
    let filter: Record<string, unknown> | undefined;
    if (this.model().useQuery) {
      const query = explorer.query();
      if (!query) return explorer.tab.set('documents');
      filter = query.filter;
    }
    const id = crypto.randomUUID();
    this.running.set(id);
    this.problem.set('');
    this.applied.set('');
    try {
      const report = await explorer.use((cases) =>
        cases.schema.sample(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          target,
          Number(this.model().size) || 1000,
          filter,
          id,
        ),
      );
      this.report.set(report);
      this.expanded.set(new Set());
      this.model.update((model) => ({
        ...model,
        validator: JSON.stringify(report.validator, null, 2),
        confirm: '',
      }));
    } catch (error) {
      this.problem.set(explorer.state.describe(error));
    } finally {
      this.running.set(undefined);
    }
  }
  async cancel() {
    const id = this.running();
    const { explorer } = this;
    if (id)
      await explorer
        .use((cases) => cases.queries.cancel(explorer.state.workspaceId(), id))
        .catch((error: unknown) => explorer.fail(error));
  }
  toggle(path: string) {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }
  /** Finds the documents with this value, in the Documents tab. */
  openValue(field: FieldSchema, value: unknown) {
    const { explorer } = this;
    explorer.model.update((model) => ({ ...model, filter: valueFilter(field, value) }));
    explorer.tab.set('documents');
    void explorer.pager.find();
  }

  async export(kind: SchemaExport) {
    const report = this.report();
    const target = this.explorer.target();
    if (!report || !target) return;
    const title = `${target.database}.${target.collection}`;
    const text =
      kind === 'csv'
        ? schemaCsv(report)
        : kind === 'markdown'
          ? schemaMarkdown(report, title)
          : `${JSON.stringify(kind === 'jsonSchema' ? report.jsonSchema : report.validator, null, 2)}\n`;
    const { suffix, extension, type } = EXPORTS[kind];
    await this.explorer.state.announce('The schema could not be exported', async () => {
      const file = await this.files.save(`${target.collection}${suffix}`, extension, type);
      if (!file) return undefined;
      await file.write(text);
      await file.close();
      return named('Schema exported', file.name);
    });
  }

  /** Replaces the validation rules of the collection with those typed, once confirmed. */
  async applyValidator() {
    const { explorer } = this;
    const target = explorer.target();
    if (!target) return;
    const m = this.model();
    this.applied.set('');
    if (m.confirm.trim() !== target.collection)
      return this.problem.set('Type the name of the collection to replace its rules');
    let validator: Record<string, unknown>;
    try {
      const value = m.validator.trim() ? shellToExtendedJson(m.validator) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      validator = value as Record<string, unknown>;
    } catch {
      return this.problem.set('The validation rules must be a document');
    }
    this.problem.set('');
    try {
      await explorer.use((cases) =>
        cases.schema.validate(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          { database: target.database, collection: target.collection },
          validator,
          m.level,
          m.action,
          m.confirm.trim(),
        ),
      );
      this.model.update((model) => ({ ...model, confirm: '' }));
      this.applied.set(
        Object.keys(validator).length ? 'Validation rules applied' : 'Validation rules removed',
      );
    } catch (error) {
      this.problem.set(explorer.state.describe(error));
    }
  }
  reset() {
    this.report.set(undefined);
    this.expanded.set(new Set());
    this.problem.set('');
    this.applied.set('');
  }
}
