import { ResultColumn } from '../../domain/db/results';
import { SqlStyle } from '../../domain/db/grid/copy';
import {
  kindColumn,
  kindOfColumn,
  matchColumns,
  previewRows,
} from '../../domain/db/transfer/import';
import type { TransferDraft } from './transfer-draft';

/** Bytes of a file read for its preview. */
const PREVIEW_BYTES = 64 * 1024;

/** How each engine quotes, for the `INSERT`s of an export written for another one. */
const STYLES: Record<string, SqlStyle> = {
  postgresql: { name: 'postgresql', quoteOpen: '"', quoteClose: '"' },
  mysql: { name: 'mysql', quoteOpen: '`', quoteClose: '`' },
  tsql: { name: 'tsql', quoteOpen: '[', quoteClose: ']' },
  sqlite: { name: 'sqlite', quoteOpen: '"', quoteClose: '"' },
};

/**
 * What the wizard does: the file of an import read for its preview, the sessions it opens
 * on the connections (its own, closed at the end), and the export, import or copy run with
 * its progress, cancelled on request.
 */
export class TransferRun {
  private abort = new AbortController();
  private readonly sessions = new Set<string>();
  /** The session that reads (export, copy) and the one that writes, with its connection. */
  private source?: string;
  private target?: { connection: string; session: string };

  constructor(private readonly draft: TransferDraft) {}

  private async cases() {
    return this.draft.section.cases();
  }

  /** A session of the wizard's own on a connection, with its driver ready. */
  private async open(connection: string, role: string): Promise<string> {
    const { section } = this.draft;
    const document = section.connection(connection);
    if (!document) throw new Error('The connection is no longer there');
    if (!(await section.ensure(this.draft.driverOf(connection))))
      throw new Error('The module of the connection is not installed');
    await section.learnQuotes(connection).catch(() => undefined);
    const session = `transfer-${role}:${connection}:${Date.now()}`;
    const cases = await this.cases();
    await cases.statements.open(this.draft.workspace(), document, session, section.state.scopes(), {
      manual: false,
    });
    this.sessions.add(session);
    return session;
  }

  /** Closes the sessions the wizard opened. */
  async close() {
    const cases = await this.cases();
    for (const session of this.sessions)
      await cases.statements.close(this.draft.workspace(), session).catch(() => undefined);
    this.sessions.clear();
    this.source = undefined;
    this.target = undefined;
  }

  private async reader() {
    this.source ??= await this.open(this.draft.request.connection, 'source');
    return this.source;
  }
  private async writer(connection: string) {
    if (this.target?.connection !== connection)
      this.target = { connection, session: await this.open(connection, 'target') };
    return this.target.session;
  }

  /** The columns of what a query reads, without reading its rows. */
  private async columnsOf(session: string, sql: string): Promise<ResultColumn[]> {
    const cases = await this.cases();
    const workspace = this.draft.workspace();
    const answer = await cases.statements.execute(workspace, session, `probe-${Date.now()}`, sql, {
      pageRows: 1,
    });
    if (answer.cursor) await cases.statements.closeCursor(workspace, session, answer.cursor);
    return answer.columns;
  }

  /** Import: the file, its first rows and its columns matched to the table's. */
  async chooseFile() {
    const draft = this.draft;
    const file = await draft.files.open(['csv', 'tsv', 'txt', 'json', 'jsonl']);
    if (!file) return;
    draft.file.set(file);
    const json = /\.jsonl?$/i.test(file.name);
    draft.model.update((model) => ({
      ...model,
      fileFormat: json ? 'json' : 'csv',
      separator: /\.tsv$/i.test(file.name) ? '\t' : model.separator,
    }));
    await this.readPreview();
  }

  async readPreview() {
    const draft = this.draft;
    const file = draft.file();
    if (!file) return;
    const model = draft.model();
    const text = new TextDecoder('utf-8').decode(await file.read(0, PREVIEW_BYTES));
    const { names, rows } = previewRows(text, model.fileFormat, model.separator, model.header);
    let table = draft.tableColumns();
    if (draft.request.table && !table.length) {
      const session = await this.writer(draft.request.connection);
      table = await this.columnsOf(session, `${draft.request.sql} WHERE 1 = 0`);
      draft.tableColumns.set(table);
    }
    const matched = matchColumns(
      names,
      rows,
      table.map((column) => column.name),
    );
    // Into a new table every column goes to one of its own name; into one that exists, its
    // values take the kind of the column they go to.
    const kindOf = (target: string) =>
      kindOfColumn(table.find((column) => column.name === target)?.kind ?? '');
    draft.columns.set(
      model.newTable
        ? matched.map((column) => ({ ...column, target: column.name }))
        : matched.map((column) => ({ ...column, kind: kindOf(column.target) ?? column.kind })),
    );
    draft.preview.set(rows.slice(0, 5));
  }

  /** Copy: the target table's `CREATE TABLE` in its engine, and what became text. */
  async prepareCopy() {
    const draft = this.draft;
    const model = draft.model();
    draft.ddl.set(undefined);
    if (!model.target) return;
    const source = await this.reader();
    const columns = await this.columnsOf(source, draft.request.sql);
    draft.tableColumns.set(columns);
    const target = await this.writer(model.target);
    const cases = await this.cases();
    const converted = await cases.transfer.convert(
      draft.workspace(),
      target,
      model.table,
      columns,
      {
        sourceDriver: draft.driverOf(draft.request.connection),
      },
    );
    draft.ddl.set({
      sql: converted.sql,
      text: converted.columns.filter((column) => column.asText).map((column) => column.name),
    });
  }

  cancel() {
    this.abort.abort();
  }

  async start() {
    const draft = this.draft;
    this.abort = new AbortController();
    draft.error.set('');
    draft.phase.set('running');
    try {
      if (draft.request.kind === 'export') await this.exportRows();
      else if (draft.request.kind === 'import') await this.importFile();
      else await this.copyRows();
    } catch (error) {
      draft.error.set(draft.section.state.describe(error));
    } finally {
      draft.phase.set('done');
      await this.close();
    }
  }

  private async exportRows() {
    const draft = this.draft;
    const model = draft.model();
    const { name, extension, type } = draft.exportName();
    const file = await draft.files.save(`${name}.${extension}`, extension, type);
    if (!file) return draft.phase.set('setup');
    const connection = draft.request.connection;
    const session = await this.reader();
    const cases = await this.cases();
    const dialect = model.dialect || draft.section.sqlStyle(connection).name;
    const style = STYLES[dialect] ?? draft.section.sqlStyle(connection);
    const table = draft.request.table?.name ?? draft.request.name;
    const exported = await cases.transfer.exportRows(
      {
        workspace: draft.workspace(),
        session,
        sql: draft.request.sql,
        format: model.format,
        options: model,
        shape: { table: draft.qualified(connection, table), style },
        ...(model.mask ? { mask: model.mask } : {}),
        ...(model.format === 'sql' && model.createTable
          ? {
              ddlFor: async (columns: ResultColumn[]) =>
                (
                  await cases.transfer.convert(draft.workspace(), session, table, columns, {
                    sourceDriver: draft.driverOf(connection),
                    targetDriver: dialect,
                  })
                ).sql,
            }
          : {}),
      },
      file,
      (rows) => draft.progress.set({ rows, bytes: 0, total: 0 }),
      this.abort.signal,
    );
    draft.exported.set(exported);
  }

  private writing() {
    const model = this.draft.model();
    return {
      mode: model.mode,
      key: [...this.draft.key()],
      stopOnError: model.stopOnError,
      clear: model.clear,
      confirm: true,
    };
  }

  private async importFile() {
    const draft = this.draft;
    const model = draft.model();
    const file = draft.file();
    if (!file) return;
    const connection = draft.request.connection;
    const session = await this.writer(connection);
    const cases = await this.cases();
    const schema = model.newTable ? undefined : draft.request.table?.schema;
    const table = model.newTable ? model.table : (draft.request.table?.name ?? model.table);
    const create = model.newTable
      ? (
          await cases.transfer.convert(
            draft.workspace(),
            session,
            table,
            draft
              .columns()
              .filter((column) => column.target)
              .map(kindColumn),
          )
        ).sql
      : undefined;
    const outcome = await cases.transfer.importFile(
      {
        workspace: draft.workspace(),
        session,
        table,
        ...(schema ? { schema } : {}),
        ...(create ? { create } : {}),
        ...this.writing(),
        format: model.fileFormat,
        separator: model.separator,
        header: model.header,
        columns: draft.columns(),
        transform: { trim: model.trim, emptyAsNull: model.emptyAsNull },
      },
      `DELETE FROM ${draft.qualified(connection, table, schema)}`,
      file,
      (done, bytes) => draft.progress.set({ rows: done.read, bytes, total: file.size }),
      this.abort.signal,
    );
    draft.outcome.set(outcome);
  }

  private async copyRows() {
    const draft = this.draft;
    const model = draft.model();
    if (!draft.ddl() || this.target?.connection !== model.target) await this.prepareCopy();
    const source = await this.reader();
    const target = await this.writer(model.target);
    const cases = await this.cases();
    const outcome = await cases.transfer.copy(
      {
        workspace: draft.workspace(),
        source,
        session: target,
        sql: draft.request.sql,
        table: model.table,
        ...(model.create && draft.ddl() ? { create: draft.ddl()!.sql } : {}),
        ...this.writing(),
      },
      `DELETE FROM ${draft.qualified(model.target, model.table)}`,
      (done) => draft.progress.set({ rows: done.read, bytes: 0, total: 0 }),
      this.abort.signal,
    );
    draft.outcome.set(outcome);
  }
}
