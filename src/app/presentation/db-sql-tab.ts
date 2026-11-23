import { AiChat } from './ai-chat';
import { AiChatSession } from './ai-chat/session';
import { AiToggle } from './ai-toggle';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { failureCode } from '../application/ports';
import { readDbConnection } from '../domain/db/connection';
import type { ResultChartConfig } from '../domain/db/result-chart';
import { engineProfile } from '../domain/db/engines';
import { SqlTemplate } from '../domain/db/sql-templates';
import { formatSql } from '../domain/db/sql-format';
import { quoteName } from '../domain/db/tree';
import { assistFor } from './db-panel/assist-source';
import { SqlPlans } from './db-panel/sql-plans';
import type { DialogAnswer, DialogRequest } from './mongo-dialog';
import { MongoDialog } from './mongo-dialog';
import { DbHistory } from './db-history';
import { DbResults } from './db-results';
import { DbSqlCode, SqlCommand } from './db-sql-code';
import { showCode, statementRange } from './db-sql-tab/code';
import { DbRunnerDialogs } from './db-runner-dialogs';
import { DbSqlOutline } from './db-sql-outline';
import { DbSqlTemplates } from './db-sql-templates';
import { DbSqlVariables } from './db-sql-variables';
import { DbSection } from './db-panel/section';
import { BuilderEdit, DbQueryBuilder } from './db-query-builder';
import { treeDatabases, treeWords } from './db-sql-tab/names';
import { DbSqlSide, DbSqlSides } from './db-sql-tab/sides';
import { DbSqlViews } from './db-sql-tab/views';
import type { DbTab } from './db-panel/tabs-store';
import { PanelTask } from './panel-task';
import { Splitter } from './splitter';
import { named } from './workspace-state';

/**
 * A SQL tab, as DBeaver's editor with SQuirreL's results: the script of a connection on its
 * own session, the statement at the cursor, a selection or the whole script run with
 * DBeaver's keys, every query leaving its result tab under it, and its history beside.
 */
@Component({
  imports: [
    TranslocoPipe,
    FormField,
    DbSqlCode,
    DbResults,
    DbHistory,
    DbRunnerDialogs,
    DbSqlVariables,
    DbSqlOutline,
    DbSqlTemplates,
    MongoDialog,
    Splitter,
    DbQueryBuilder,
    DbSqlViews,
    DbSqlSides,
    AiChat,
    AiToggle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-tab',
  templateUrl: './db-sql-tab.html',
  styleUrl: './db-sql-tab.scss',
})
export class DbSqlTab {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  private readonly code = viewChild(DbSqlCode);
  protected readonly runner = computed(() => this.section.runner(this.tab().id));
  /** The isolation levels the driver lets a transaction begin with. */
  protected readonly isolations = computed(
    () => this.section.drivers.capabilities(this.tab().connection)?.isolationLevels ?? [],
  );
  /** The person's own templates, beside the editor's. */
  protected readonly templates = signal<readonly SqlTemplate[]>([]);
  /** Completion with the schema, templates and going to objects (DB-15). */
  protected readonly assist = computed(() =>
    assistFor(this.section, this.runner(), () => this.templates()),
  );
  protected readonly draft = computed(() => this.section.tabs.draft(this.tab().id));
  protected readonly connection = computed(() => this.section.connection(this.tab().connection));
  protected readonly value = computed(() => readDbConnection(this.connection()?.value));
  protected readonly production = computed(
    () => this.section.rulesOf(this.tab().connection).confirmWrites,
  );
  protected readonly profile = computed(() => engineProfile(this.value().driver));
  protected readonly script = computed(() =>
    this.section.scripts().find((document) => document.id === this.draft().script),
  );
  /** The text this editor opened with; typing is kept in the draft. */
  protected readonly opened = signal({ text: '', cursor: 0 });
  protected readonly codeHeight = signal(0);
  private readonly assistant = inject(AiChatSession);
  /** The panel beside the editor, one at a time; the assistant stays open from tab to tab. */
  protected readonly side = signal<DbSqlSide>(this.assistant.sql() ? 'ai' : '');
  private readonly keepAssistant = effect(() => this.assistant.sql.set(this.side() === 'ai'));
  protected readonly dialog = signal<
    { request: DialogRequest; run: (a: DialogAnswer) => void } | undefined
  >(undefined);
  protected readonly where = signal({ database: '', schema: '' });
  protected readonly whereFields = form(this.where);
  /** Where the history keys (Ctrl+Alt+↑ and ↓) are among this connection's statements. */
  private historyIndex = -1;
  protected readonly words = computed(() => treeWords(this.section, this.tab().connection));
  protected readonly databases = computed(() => treeDatabases(this.section, this.tab().connection));
  /** The script as text, or its statement at the cursor in the visual builder (DB-26). */
  protected readonly view = signal<'text' | 'visual'>('text');

  constructor() {
    void this.section.cases().then((cases) => this.templates.set(cases.assist.templates()));
    effect(() => {
      const tab = this.tab();
      untracked(() => {
        const draft = this.section.tabs.draft(tab.id);
        this.opened.set({ text: draft.text, cursor: draft.cursor });
        this.where.set({ database: draft.database ?? '', schema: '' });
      });
    });
    effect(() => {
      const runner = this.runner();
      const at = runner.errorAt();
      if (at) untracked(() => this.code()?.goToOffset(at.offset));
    });
    afterNextRender(() => {
      const id = this.tab().id;
      if (!this.section.runOnOpen().has(id)) return;
      this.section.runOnOpen.update((set) => new Set([...set].filter((other) => other !== id)));
      void this.runner().runScript(this.draft().text);
    });
  }

  protected changed(text: string) {
    this.section.tabs.setDraft(this.tab().id, { text, dirty: true });
  }
  protected moved(cursor: number) {
    this.section.tabs.setDraft(this.tab().id, { cursor });
  }

  protected command(command: SqlCommand) {
    const code = this.code();
    if (!code) return;
    const runner = this.runner();
    const text = code.content();
    const selection = code.selection();
    // Walking the history starts again from the newest after something new runs.
    if (command !== 'previous' && command !== 'next') this.historyIndex = -1;
    switch (command) {
      case 'run':
      case 'run-new':
        code.markRan(selection.from, selection.to);
        return void runner.runAt(text, selection.from, selection, command === 'run-new');
      case 'script':
        return void runner.runScript(text);
      case 'save':
        return this.save();
      case 'cancel':
        return void runner.cancel();
      case 'previous':
      case 'next':
        return void this.walkHistory(command === 'previous' ? 1 : -1);
      case 'commit':
      case 'rollback':
        if (runner.transaction()?.open) void runner.transact(command);
        return;
      case 'format':
        return this.format(code, text, selection);
      case 'explain':
        return void new SqlPlans(runner).explainAt(text, selection.from, selection);
    }
  }

  /** Formats the selection, or the statement at the cursor (Ctrl+Shift+F). */
  private format(code: DbSqlCode, text: string, selection: { from: number; to: number }) {
    const { start, end } = statementRange(text, selection);
    if (end > start) code.replaceRange(start, end, formatSql(text.slice(start, end)));
  }
  /** The code of the selection or of the statement at the cursor (DB-33). */
  protected showCode() {
    const code = this.code();
    if (code) void showCode(code, this.runner());
  }

  /** Puts an older or newer statement of this connection's history in the editor. */
  private async walkHistory(step: 1 | -1) {
    const cases = await this.section.cases();
    const entries = (await cases.statements.entries(this.section.state.documents())).filter(
      (entry) => entry.connectionId === this.tab().connection,
    );
    const next = Math.min(Math.max(this.historyIndex + step, 0), entries.length - 1);
    if (!entries[next]) return;
    this.historyIndex = next;
    this.code()?.replace(entries[next].sql);
  }

  /** Opens the session on the database and schema chosen in the header. */
  protected useWhere() {
    const { database, schema } = this.where();
    void this.task.run(async () => {
      const runner = this.runner();
      if ((database || '') !== (this.draft().database ?? '')) await runner.useDatabase(database);
      const statement = this.profile().schemaStatement;
      if (schema.trim() && statement) {
        const style = this.section.quoteStyle(this.tab().connection);
        await runner.runScript(statement(quoteName(schema.trim(), style)));
      }
    });
  }

  /** Saves the script (Ctrl+S): over its document, or as a new one after naming it. */
  protected save() {
    const existing = this.script();
    if (existing) return void this.write(existing.name, existing);
    this.dialog.set({
      request: {
        title: 'Save script',
        first: { label: 'Script name', value: 'Script' },
        second: { label: 'Folder', value: '' },
        confirm: 'Save',
      },
      run: ({ first, second }) => void this.write(first, undefined, second),
    });
  }

  private write(name: string, existing?: { id: string; name: string }, folder = '') {
    this.dialog.set(undefined);
    void this.task.announce('The script could not be saved', async () => {
      const cases = await this.section.cases();
      const draft = this.draft();
      const current = this.section.scripts().find((document) => document.id === existing?.id);
      const value = {
        connectionId: this.tab().connection,
        sql: this.code()?.content() ?? draft.text,
        ...(folder.trim() ? { folder: folder.trim() } : {}),
        ...(draft.database ? { database: draft.database } : {}),
        ...(draft.charts ? { charts: draft.charts } : {}),
      };
      const id = current?.id ?? this.section.state.cases.files.id();
      const save = (base = current) =>
        cases.statements.saveScript(this.section.state.workspaceId(), id, name, value, base);
      let saved;
      try {
        saved = await save();
      } catch (error) {
        if (failureCode(error) !== 'conflict') throw error;
        await this.section.state.refresh();
        const latest = this.section.scripts().find((document) => document.id === id);
        if (!latest || !this.section.state.confirm('db.script.conflict')) return undefined;
        saved = await save(latest);
      }
      await this.section.state.refresh();
      this.section.tabs.setDraft(this.tab().id, { script: saved.id, dirty: false });
      this.section.tabs.update(this.tab().id, { title: saved.name });
      return named('Script saved', saved.name);
    });
  }

  /** The editor goes to where an error is. */
  protected goTo(offset: number) {
    this.code()?.goToOffset(offset);
  }

  /** A chart of a result changed: it is kept with the script (DB-28). */
  protected chart(change: { key: string; config: ResultChartConfig }) {
    const charts = { ...this.draft().charts, [change.key]: change.config };
    this.section.tabs.setDraft(this.tab().id, { charts, dirty: true });
  }

  /** The builder wrote its statement again; the cursor stays at its start. */
  protected built(edit: BuilderEdit) {
    this.code()?.replaceRange(edit.from, edit.to, edit.text, edit.from);
  }

  /** An entry of the history goes into the editor. */
  protected useHistory(sql: string) {
    this.code()?.replace(sql);
  }

  protected answerDialog(answer: DialogAnswer) {
    this.dialog()?.run(answer);
  }
}
