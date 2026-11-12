import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { ShellEntry, confirmationAsked, shellWords } from '../../domain/mongo-shell';
import type { MongoExplorer } from '../mongo-explorer';

/** What the shell edits. */
export interface ShellModel {
  command: string;
  /** The name typed to confirm a destructive command. */
  confirm: string;
}

/** A destructive command waiting for its name to be typed. */
export interface PendingCommand {
  what: 'collection' | 'database';
  name: string;
  command: string;
  database: string;
}

/** Entries of the output kept. */
const KEPT = 100;
/** Commands that may change the databases and collections listed. */
const CHANGES = /\.(insert|update|replace|delete|drop|createIndex|createCollection)|dropDatabase/;

/**
 * The shell of a connection: commands as in mongosh run by the engine, their output, the
 * confirmation a destructive command asks for, and the history of commands of the connection.
 */
export class MongoConsole {
  readonly model = signal<ShellModel>({ command: '', confirm: '' });
  readonly fields;
  /** The database the next command starts in. */
  readonly database = signal('');
  readonly entries = signal<ShellEntry[]>([]);
  readonly running = signal(false);
  readonly pending = signal<PendingCommand | undefined>(undefined);
  readonly history = signal<string[]>([]);
  /** The command of the history shown in the editor, counted from the newest. */
  private back = 0;
  readonly words = computed(() =>
    shellWords(this.explorer.browser.listed(this.database()).map((c) => c.name)),
  );

  constructor(
    private readonly explorer: MongoExplorer,
    injector: Injector,
  ) {
    this.fields = runInInjectionContext(injector, () => form(this.model));
  }

  /** Opens the shell in the database chosen, or the first one listed. */
  async open() {
    const { explorer } = this;
    this.database.set(
      explorer.target()?.database ?? explorer.browser.databases()[0]?.name ?? 'test',
    );
    const database = this.database();
    if (!explorer.browser.collections()[database]) void explorer.browser.loadCollections(database);
    this.history.set(
      await explorer.use(async (cases) => cases.shell.history(explorer.connection().id)),
    );
    this.back = 0;
  }

  async run() {
    const command = this.model().command;
    if (!command.trim() || this.running()) return;
    const { explorer } = this;
    this.history.set(
      await explorer.use(async (cases) => cases.shell.remember(explorer.connection().id, command)),
    );
    this.back = 0;
    await this.execute(command, this.database());
  }
  /** Runs the destructive command waiting, once its name is typed. */
  async confirm() {
    const pending = this.pending();
    if (!pending || this.model().confirm.trim() !== pending.name) return;
    this.pending.set(undefined);
    await this.execute(pending.command, pending.database, pending.name);
    this.model.update((model) => ({ ...model, confirm: '' }));
  }
  cancelPending() {
    this.pending.set(undefined);
    this.model.update((model) => ({ ...model, confirm: '' }));
  }
  private async execute(command: string, database: string, confirm?: string) {
    const { explorer } = this;
    this.running.set(true);
    try {
      const answer = await explorer.use((cases) =>
        cases.shell.run(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          database,
          command,
          confirm,
        ),
      );
      this.add({ command, database, answer });
      this.database.set(answer.database);
      if (CHANGES.test(command)) void explorer.browser.loadDatabases();
      else if (!explorer.browser.collections()[answer.database])
        void explorer.browser.loadCollections(answer.database);
    } catch (error) {
      const message = explorer.state.describe(error);
      const asked = confirmationAsked(message);
      if (asked && !confirm) this.pending.set({ ...asked, command, database });
      else this.add({ command, database, error: message });
    } finally {
      this.running.set(false);
    }
  }
  private add(entry: ShellEntry) {
    this.entries.update((entries) => [...entries, entry].slice(-KEPT));
  }
  /** Shows an older (1) or newer (-1) command of the history in the editor. */
  recall(step: 1 | -1) {
    const history = this.history();
    const back = Math.min(Math.max(this.back + step, 0), history.length);
    this.back = back;
    const command = back ? history[history.length - back] : '';
    this.model.update((model) => ({ ...model, command }));
  }
  use(command: string) {
    this.model.update((model) => ({ ...model, command }));
  }
  clear() {
    this.entries.set([]);
  }
}
