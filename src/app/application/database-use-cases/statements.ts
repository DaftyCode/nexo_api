import { WorkspaceDocument } from '../../domain/models';
import { GridFormats, readGridFormats } from '../../domain/db/grid/cells';
import { DEFAULT_MAX_RESULTS, ExecuteAnswer } from '../../domain/db/results';
import { HistoryEntry, ScriptValue, SplitAnswer, readHistory } from '../../domain/db/sql';
import { VariableScopes } from '../../domain/variables';
import { DocumentRepositoryPort, ExecutionPort, PreferencePort } from '../ports';
import { connectionVariables } from './connections';
import { DbServerInfo } from './navigator';

/** The session of a SQL tab: its own, so two scripts never share a transaction. */
export const editorSession = (tab: string) => `editor:${tab}`;

/** What a transaction is like in a session. */
export interface TransactionState {
  autoCommit: boolean;
  open: boolean;
}

/** What to do with the rest of a script when a statement fails. */
export type ScriptFailure = 'ask' | 'continue' | 'stop';

export type StatementPorts = ExecutionPort &
  Pick<DocumentRepositoryPort, 'save' | 'document' | 'remove'>;

const MAX_RESULTS = 'db.maxResults';
const ON_FAILURE = 'db.scriptFailure';
const GRID_FORMATS = 'db.gridFormats';
/** The history entries read when the panel opens, newest first. */
const HISTORY_READ = 200;

/**
 * The SQL editor: its sessions, the statements of a script, running them and reading their
 * rows by pages, transactions, saved scripts and the history of what ran.
 */
export class DatabaseStatementCases {
  private readonly history = new Map<string, HistoryEntry | null>();

  constructor(
    private readonly api: StatementPorts,
    private readonly preferences: PreferencePort,
  ) {}

  /**
   * Opens the session of a SQL tab, on another database of the server when one is given,
   * and leaves its commits manual when the connection asks for that.
   */
  async open(
    workspace: string,
    connection: WorkspaceDocument,
    session: string,
    scopes: VariableScopes,
    options: { database?: string; manual: boolean },
  ): Promise<{ server: DbServerInfo; transaction: TransactionState }> {
    const server = await this.api.execute<DbServerInfo>('db.connect', {
      workspace,
      connectionId: connection.id,
      session,
      variables: connectionVariables(connection.value, scopes),
      ...(options.database ? { database: options.database } : {}),
    });
    const transaction = await this.transaction(
      workspace,
      session,
      options.manual ? 'manual' : 'status',
    );
    return { server, transaction };
  }

  close(workspace: string, session: string): Promise<void> {
    return this.api.execute<void>('db.disconnect', { workspace, session });
  }

  split(workspace: string, script: string, dialect: string, offset?: number) {
    return this.api.execute<SplitAnswer>('db.split', {
      workspace,
      script,
      dialect,
      ...(offset === undefined ? {} : { offset }),
    });
  }

  execute(
    workspace: string,
    session: string,
    statement: string,
    sql: string,
    options: {
      pageRows?: number;
      params?: unknown[];
      confirm?: boolean;
      confirmName?: string;
    } = {},
  ): Promise<ExecuteAnswer> {
    return this.api.execute<ExecuteAnswer>('db.execute', {
      workspace,
      session,
      statement,
      sql,
      ...(options.pageRows ? { pageRows: options.pageRows } : {}),
      ...(options.params?.length ? { params: options.params } : {}),
      ...(options.confirm ? { confirm: true } : {}),
      ...(options.confirmName ? { confirmName: options.confirmName } : {}),
    });
  }

  fetch(workspace: string, session: string, cursor: string, pageRows?: number) {
    return this.api.execute<{ rows: unknown[][]; cursor?: string | null }>('db.fetch', {
      workspace,
      session,
      cursor,
      ...(pageRows ? { pageRows } : {}),
    });
  }

  /** Closes a cursor that is no longer read; one already gone is closed too. */
  async closeCursor(workspace: string, session: string, cursor: string) {
    await this.api.execute<void>('db.close', { workspace, session, cursor }).catch(() => undefined);
  }

  cancel(workspace: string, session: string, statement: string): Promise<void> {
    return this.api.execute<void>('db.cancel', { workspace, session, statement });
  }

  transaction(
    workspace: string,
    session: string,
    action: 'status' | 'begin' | 'commit' | 'rollback' | 'auto' | 'manual',
  ) {
    return this.api.execute<TransactionState>('db.transaction', { workspace, session, action });
  }

  /** Saves a script with its revision; `existing` is the version it was loaded from. */
  saveScript(
    workspace: string,
    id: string,
    name: string,
    value: ScriptValue,
    existing?: WorkspaceDocument,
  ) {
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'sql-script',
      name: name.trim() || 'Script',
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value,
    });
  }

  removeScript(document: WorkspaceDocument) {
    return this.api.remove(document);
  }

  /**
   * The statements recorded in the history, newest first: the latest ones are read once
   * (they never change) and kept.
   */
  async entries(documents: readonly WorkspaceDocument[]): Promise<HistoryEntry[]> {
    const latest = documents
      .filter((document) => document.kind === 'sql-history')
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, HISTORY_READ);
    await Promise.all(
      latest
        .filter((document) => !this.history.has(document.id))
        .map(async (document) => {
          const read = await this.api.document(document.id).catch(() => undefined);
          this.history.set(document.id, read ? (readHistory(read.id, read.value) ?? null) : null);
        }),
    );
    return latest
      .map((document) => this.history.get(document.id))
      .filter((entry): entry is HistoryEntry => !!entry)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** The most result tabs a SQL tab keeps. */
  maxResults(): number {
    const stored = Number(this.preferences.read(MAX_RESULTS));
    return Number.isInteger(stored) && stored >= 1 && stored <= 100 ? stored : DEFAULT_MAX_RESULTS;
  }
  setMaxResults(count: number) {
    this.preferences.write(MAX_RESULTS, String(Math.min(100, Math.max(1, Math.round(count)))));
  }
  /** What a script does when one of its statements fails, as the person chose. */
  onFailure(): ScriptFailure {
    const stored = this.preferences.read(ON_FAILURE);
    return stored === 'continue' || stored === 'stop' ? stored : 'ask';
  }
  setOnFailure(choice: ScriptFailure) {
    this.preferences.write(ON_FAILURE, choice === 'ask' ? '' : choice);
  }
  /** How the data grids write `NULL`, decimals and dates. */
  gridFormats(): GridFormats {
    return readGridFormats(this.preferences.read(GRID_FORMATS));
  }
  setGridFormats(formats: GridFormats) {
    this.preferences.write(GRID_FORMATS, JSON.stringify(readGridFormats(JSON.stringify(formats))));
  }
}
