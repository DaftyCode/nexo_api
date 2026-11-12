import { signal } from '@angular/core';
import { WorkspaceState, success } from './workspace-state';
import { DialogAnswer, DialogRequest } from './mongo-dialog';
import { ResultsEdit } from './mongo-results';
import type {
  MongoUseCases,
  QueryTarget,
  WriteAnswer,
  WriteWhere,
} from '../application/mongo-use-cases';
import { WorkspaceDocument } from '../domain/models';
import {
  dropCollection,
  dropDatabase,
  newCollection,
  renameCollection,
} from './mongo-collection-writes';
import { deleteMany, updateMany } from './mongo-many-writes';
import { shell } from '../domain/bson';
import {
  WriteConcernChoice,
  WriteTextError,
  dottedPath,
  duplicate,
  idFilter,
  parseDocuments,
  parseValue,
  setField,
  unsetField,
  writeConcern,
} from '../domain/mongo-write';

/** What the explorer gives the writes. */
export interface WriteContext {
  state: WorkspaceState;
  cases: () => Promise<MongoUseCases>;
  connection: () => WorkspaceDocument;
  target: () => QueryTarget | undefined;
  /** The filter of the query bar; `undefined` when it cannot be read (it says why). */
  filter: () => Record<string, unknown> | undefined;
  /** Reads the page shown again. */
  refresh: () => Promise<void>;
  reloadCollections: (database: string) => Promise<void>;
  reloadDatabases: () => Promise<void>;
  /** Chooses a collection, or none after it was dropped. */
  choose: (database: string, collection?: string) => Promise<void>;
  fail: (error: unknown) => void;
}

type Action = (answer: DialogAnswer) => Promise<string>;

/** What a write needs of the dialog: the explorer, where it writes, and asking first. */
export interface WriteDialog {
  readonly context: WriteContext;
  readonly scope: readonly [string, WorkspaceDocument, ReturnType<WorkspaceState['scopes']>];
  ask(request: DialogRequest, action: Action): void;
  where(): WriteWhere;
  written(answer: WriteAnswer): Promise<void>;
  run(action: () => Promise<void>): void;
}

/**
 * Writes of the MongoDB explorer, each through a dialog that says what will happen: fields
 * and documents edited, inserted, duplicated and deleted, writes to many documents after
 * counting them, collections and databases created, renamed, emptied and dropped, and
 * recorded changes undone. The backend checks the same rules again.
 */
export class MongoWrites implements WriteDialog {
  readonly dialog = signal<DialogRequest | undefined>(undefined);
  readonly problem = signal<{ key: string; params?: Record<string, unknown> } | undefined>(
    undefined,
  );
  readonly busy = signal(false);
  readonly concern = signal<WriteConcernChoice>('');
  /** What the last write did, as a message key with its values. */
  readonly notice = signal<{ key: string; params?: Record<string, unknown> } | undefined>(
    undefined,
  );
  private pending: Action | undefined;

  constructor(readonly context: WriteContext) {}

  get scope() {
    const { state, connection } = this.context;
    return [state.workspaceId(), connection(), state.scopes()] as const;
  }
  where() {
    const target = this.context.target();
    if (!target) throw new Error('Choose a collection');
    const concern = writeConcern(this.concern());
    return { ...target, ...(concern ? { writeConcern: concern } : {}) };
  }

  ask(request: DialogRequest, action: Action) {
    this.problem.set(undefined);
    this.pending = action;
    this.dialog.set(request);
  }
  cancel() {
    this.dialog.set(undefined);
    this.pending = undefined;
  }
  /**
   * Runs what the dialog asked and says in a toast what it did; on failure the dialog stays
   * open with the reason, where it can be corrected.
   */
  async answer(answer: DialogAnswer) {
    const action = this.pending;
    if (!action || this.busy()) return;
    this.busy.set(true);
    this.problem.set(undefined);
    try {
      const done = await action(answer);
      this.cancel();
      this.notice.set({ key: done });
      this.context.state.tell(success(done));
    } catch (error) {
      this.problem.set(
        error instanceof WriteTextError
          ? { key: error.key, params: error.params }
          : { key: this.context.state.describe(error) },
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Shows the record of a write, and the page as it is now. */
  async written(answer: WriteAnswer) {
    const cases = await this.context.cases();
    this.context.state.applySaved([await cases.writes.change(answer.change)]);
    await this.context.refresh();
  }

  /** A write the results asked for on what is selected. */
  edit({ action, document, path, value }: ResultsEdit) {
    const filter = () => idFilter(document);
    switch (action) {
      case 'edit':
        if (path.length)
          this.ask(
            {
              title: 'Edit value',
              message: { key: 'mongo.editing', params: { v0: dottedPath(path) } },
              editor: { label: 'Value', value: shell(value) },
              confirm: 'Save',
            },
            async ({ text }) => {
              const cases = await this.context.cases();
              await this.written(
                await cases.writes.update(
                  ...this.scope,
                  this.where(),
                  filter(),
                  setField(path, parseValue(text)),
                ),
              );
              return 'Value saved';
            },
          );
        else
          this.ask(
            {
              title: 'Edit document',
              editor: { label: 'Document', value: shell(document) },
              confirm: 'Save',
            },
            async ({ text }) => {
              const [replacement, ...more] = parseDocuments(text);
              if (more.length) throw new WriteTextError('mongo.oneDocument');
              const cases = await this.context.cases();
              await this.written(
                await cases.writes.replace(...this.scope, this.where(), filter(), replacement),
              );
              return 'Document saved';
            },
          );
        return;
      case 'unset':
        this.ask(
          {
            title: 'Remove field',
            message: { key: 'mongo.removing', params: { v0: dottedPath(path) } },
            confirm: 'Remove field',
            danger: true,
          },
          async () => {
            const cases = await this.context.cases();
            await this.written(
              await cases.writes.update(...this.scope, this.where(), filter(), unsetField(path)),
            );
            return 'Field removed';
          },
        );
        return;
      case 'duplicate':
        this.insert(shell(duplicate(document)));
        return;
      case 'delete':
        this.ask(
          {
            title: 'Delete document',
            message: { key: 'mongo.deletingOne', params: { v0: shell(document['_id']) } },
            confirm: 'Delete document',
            danger: true,
          },
          async () => {
            const cases = await this.context.cases();
            await this.written(
              await cases.writes.deleteDocuments(...this.scope, this.where(), filter()),
            );
            return 'Document deleted';
          },
        );
    }
  }

  /** Inserts one document or an array of them. */
  insert(text = '{\n  \n}') {
    this.ask(
      {
        title: 'Insert documents',
        message: {
          key: 'One document, or several in an array, in the shell syntax or Extended JSON.',
        },
        editor: { label: 'Documents', value: text },
        confirm: 'Insert',
      },
      async ({ text }) => {
        const cases = await this.context.cases();
        const answer = await cases.writes.insert(...this.scope, this.where(), parseDocuments(text));
        await this.written(answer);
        return 'Documents inserted';
      },
    );
  }

  /** Updates every document the filter matches, after counting them. */
  updateMany() {
    updateMany(this);
  }
  /** Deletes every document the filter matches, after counting them. */
  deleteMany(everything = false) {
    deleteMany(this, everything);
  }

  /** A new collection, in `database` or in a new database. */
  newCollection(database?: string) {
    newCollection(this, database);
  }
  rename() {
    renameCollection(this);
  }
  dropCollection() {
    dropCollection(this);
  }
  dropDatabase() {
    dropDatabase(this);
  }

  /** Undoes a recorded write: each document goes back, if nobody changed it since. */
  undo(change: WorkspaceDocument) {
    this.ask(
      {
        title: 'Undo change',
        message: { key: 'mongo.undoing', params: { v0: change.name } },
        confirm: 'Undo',
      },
      async () => {
        const cases = await this.context.cases();
        await this.written(await cases.writes.undo(...this.scope, change.id));
        return 'Change undone';
      },
    );
  }

  /** Runs an action that may fail before its dialog opens (a count), showing why. */
  run(action: () => Promise<void>) {
    void action().catch((error: unknown) => this.context.fail(error));
  }
}
