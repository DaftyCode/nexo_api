import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { MockBatch } from '../application/database-use-cases';
import { TRANSFER_FILES } from '../composition/providers';
import {
  MOCK_KINDS,
  MOCK_MAX_BATCH,
  MOCK_MAX_ROWS,
  MOCK_PREVIEW,
  MOCK_ROWS,
  MockColumnPlan,
  MockGenerator,
  MockKind,
  MockLanguage,
  generatorOf,
  mockColumns,
  mockPlan,
} from '../domain/db/mock';
import type { ResultColumn } from '../domain/db/results';
import { defaultExportOptions, exportWriter } from '../domain/db/transfer/export';
import type { MockRequest } from './db-panel/mock-request';
import { navigatorSession } from './db-panel/navigator-session';
import { DbSection } from './db-panel/section';
import { PanelTask } from './panel-task';
import { DbMockSettings } from './db-mock-data/settings';
import { success } from './workspace-state';

interface MockOptions {
  rows: number;
  batch: number;
  seed: number;
  language: MockLanguage;
  /** Empty the table first, once its name is typed. */
  empty: boolean;
  typed: string;
}

/**
 * «Generate test data» of a table (DB-27): a generator for each column, chosen from its type
 * and name, the rows to make with their seed, a preview of twenty, and the run by batches with
 * its progress and a way to stop it; or the same rows as a script of `INSERT`s or a CSV file,
 * without writing to the database.
 */
@Component({
  imports: [TranslocoPipe, DbMockSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-mock-data',
  templateUrl: './db-mock-data.html',
  styleUrl: './db-mock-data.scss',
})
export class DbMockData {
  readonly request = input.required<MockRequest>();
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  private readonly files = inject(TRANSFER_FILES);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly plan = signal<MockColumnPlan[]>([]);
  protected readonly options = signal<MockOptions>({
    rows: MOCK_ROWS,
    batch: 1_000,
    seed: Math.floor(Math.random() * 1_000_000),
    language: 'en',
    empty: false,
    typed: '',
  });
  protected readonly preview = signal<{ columns: string[]; rows: unknown[][] } | undefined>(
    undefined,
  );
  protected readonly progress = signal<{ done: number; total: number } | undefined>(undefined);
  protected readonly report = signal<MockBatch | undefined>(undefined);
  protected readonly kinds = MOCK_KINDS;
  private stopped = false;
  protected readonly problem = computed(() => {
    const options = this.options();
    if (!this.plan().some((column) => column.include)) return 'Choose at least one column to fill';
    if (!Number.isInteger(options.rows) || options.rows < 1 || options.rows > MOCK_MAX_ROWS)
      return 'db.mock.rowsRange';
    if (!Number.isInteger(options.batch) || options.batch < 1 || options.batch > MOCK_MAX_BATCH)
      return 'db.mock.batchRange';
    if (options.empty && options.typed !== this.request().table.name)
      return 'Type the name of the table to empty it first';
    return '';
  });

  constructor() {
    const once = effect(() => {
      this.request();
      untracked(() => void this.load());
      once.destroy();
    });
  }

  private at() {
    return navigatorSession(this.section, this.request().connection);
  }
  private async load() {
    await this.task.run(async () => {
      const at = await this.at();
      const table = await at.cases.mock.structure(at.workspace, at.session, this.request().path);
      this.plan.set(mockPlan(table, this.options().language));
    });
  }

  protected setColumn(index: number, patch: Partial<MockColumnPlan>) {
    this.plan.update((plan) =>
      plan.map((column, at) => (at === index ? { ...column, ...patch } : column)),
    );
  }
  protected setGenerator(index: number, patch: Record<string, unknown>) {
    const column = this.plan()[index];
    this.setColumn(index, { generator: { ...column.generator, ...patch } as MockGenerator });
  }
  protected setKind(index: number, kind: MockKind) {
    this.setColumn(index, { generator: generatorOf(kind, this.options().language) });
  }
  protected setOption(patch: Partial<MockOptions>) {
    this.options.update((options) => ({ ...options, ...patch }));
  }
  protected number(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }
  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** The columns as the engine takes them, with the keys of the tables they reference. */
  private async columns() {
    const at = await this.at();
    const style = this.section.sqlStyle(this.request().connection);
    const keys: Record<string, unknown[]> = {};
    for (const column of this.plan())
      if (column.include && column.generator.kind === 'foreign' && column.foreign)
        keys[column.name] = await at.cases.mock.keys(
          at.workspace,
          at.session,
          column.foreign,
          style,
        );
    return { at, style, columns: mockColumns(this.plan(), keys) };
  }

  protected showPreview() {
    if (this.problem()) return;
    void this.task.run(async () => {
      const { at, columns } = await this.columns();
      const { seed } = this.options();
      this.preview.set(
        await at.cases.mock.rows(at.workspace, at.session, this.request().table, columns, {
          seed,
          first: 0,
          count: MOCK_PREVIEW,
        }),
      );
    });
  }

  /** Writes every batch, saying how far it got; stopping ends it after the batch in flight. */
  protected generate() {
    if (this.problem()) return;
    const request = this.request();
    void this.task.announce('The test data could not be written', async () => {
      const { at, style, columns } = await this.columns();
      const { rows, batch, seed, empty } = this.options();
      if (empty)
        await at.cases.mock.empty(
          at.workspace,
          at.session,
          request.table.qualified,
          request.table.name,
          style,
        );
      const report: MockBatch = { inserted: 0, failed: 0, failures: [] };
      this.stopped = false;
      this.report.set(undefined);
      for (let first = 0; first < rows && !this.stopped; first += batch) {
        this.progress.set({ done: first, total: rows });
        const done = await at.cases.mock.rows<MockBatch>(
          at.workspace,
          at.session,
          request.table,
          columns,
          {
            seed,
            first,
            count: Math.min(batch, rows - first),
            write: true,
          },
        );
        report.inserted += done.inserted;
        report.failed += done.failed;
        report.failures.push(...(done.failures ?? []).slice(0, 5 - report.failures.length));
      }
      this.progress.set(undefined);
      this.report.set(report);
      return success('Test data written', 'db.mock.written', {
        v0: String(report.inserted),
        v1: String(report.failed),
      });
    });
  }
  protected stop() {
    this.stopped = true;
  }

  /** The same rows as a script of INSERTs or a CSV file, without writing to the database. */
  protected save(format: 'sql' | 'csv') {
    if (this.problem()) return;
    const request = this.request();
    void this.task.run(async () => {
      const target = await this.files.save(
        request.table.name,
        format,
        format === 'sql' ? 'application/sql' : 'text/csv',
      );
      if (!target) return;
      const { at, style, columns } = await this.columns();
      const shape = {
        columns: columns.map((column) => ({ name: String(column['name']) }) as ResultColumn),
        table: request.table.qualified,
        style,
      };
      const writer = exportWriter(format, shape, defaultExportOptions());
      const { rows, batch, seed } = this.options();
      this.stopped = false;
      await target.write(writer.start());
      for (let first = 0; first < rows; first += batch) {
        if (this.stopped) return target.discard();
        this.progress.set({ done: first, total: rows });
        const page = await at.cases.mock.rows(at.workspace, at.session, request.table, columns, {
          seed,
          first,
          count: Math.min(batch, rows - first),
        });
        await target.write(writer.page(page.rows));
      }
      await target.write(writer.end());
      await target.close();
      this.progress.set(undefined);
    });
  }
}
