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
import { connectionType, readDbConnection } from '../domain/db/connection';
import { engineProfile } from '../domain/db/engines';
import { nodeKey, quoteName } from '../domain/db/tree';
import type { DialogAnswer, DialogRequest } from './mongo-dialog';
import { MongoDialog } from './mongo-dialog';
import { DbHistory } from './db-history';
import { DbResults } from './db-results';
import { DbSqlCode, SqlCommand } from './db-sql-code';
import { DbSection } from './db-panel/section';
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
  imports: [TranslocoPipe, FormField, DbSqlCode, DbResults, DbHistory, MongoDialog, Splitter],
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
  protected readonly draft = computed(() => this.section.tabs.draft(this.tab().id));
  protected readonly connection = computed(() => this.section.connection(this.tab().connection));
  protected readonly value = computed(() => readDbConnection(this.connection()?.value));
  protected readonly production = computed(() => connectionType(this.value()) === 'production');
  protected readonly profile = computed(() => engineProfile(this.value().driver));
  protected readonly script = computed(() =>
    this.section.scripts().find((document) => document.id === this.draft().script),
  );
  /** The text this editor opened with; typing is kept in the draft. */
  protected readonly opened = signal({ text: '', cursor: 0 });
  protected readonly codeHeight = signal(0);
  protected readonly showHistory = signal(false);
  protected readonly dialog = signal<
    { request: DialogRequest; run: (a: DialogAnswer) => void } | undefined
  >(undefined);
  protected readonly where = signal({ database: '', schema: '' });
  protected readonly whereFields = form(this.where);
  protected readonly failure = signal({ remember: false });
  protected readonly failureFields = form(this.failure);
  /** Where the history keys (Ctrl+Alt+↑ and ↓) are among this connection's statements. */
  private historyIndex = -1;
  /** Names of the loaded tree of the connection, suggested while typing. */
  protected readonly words = computed(() => {
    const prefix = nodeKey(this.tab().connection, []);
    const names = new Set<string>();
    for (const [key, nodes] of this.section.tree.children())
      if (key === prefix || key.startsWith(`${prefix}/`))
        for (const node of nodes) if (node.kind !== 'folder') names.add(node.label.split('(')[0]);
    return [...names];
  });
  /** Databases of the server the tree loaded, to choose one: at its top, or in a folder. */
  protected readonly databases = computed(() => {
    const children = this.section.tree.children();
    const connection = this.tab().connection;
    return [[], ['databases']]
      .flatMap((path) => children.get(nodeKey(connection, path)) ?? [])
      .filter((node) => node.kind === 'database')
      .map((node) => node.label);
  });

  constructor() {
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
    }
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

  /** An entry of the history goes into the editor. */
  protected useHistory(sql: string) {
    this.code()?.replace(sql);
  }

  protected answerDialog(answer: DialogAnswer) {
    this.dialog()?.run(answer);
  }
  protected confirmRequest(): DialogRequest | undefined {
    const dialog = this.runner().dialog();
    if (dialog?.kind !== 'confirm') return undefined;
    const { confirmation } = dialog;
    return {
      title: 'Confirm the statement',
      message: { key: confirmation.message, params: confirmation.params },
      ...(confirmation.names ? { confirmName: confirmation.names } : {}),
      confirm: 'Run',
      danger: true,
    };
  }
  protected confirmAnswer(ok: boolean) {
    const dialog = this.runner().dialog();
    if (dialog?.kind === 'confirm') dialog.answer(ok);
  }
  protected failureAnswer(choice: 'continue' | 'stop' | 'ignore') {
    const dialog = this.runner().dialog();
    if (dialog?.kind === 'failure') dialog.answer(choice, this.failure().remember);
    this.failure.set({ remember: false });
  }
}
