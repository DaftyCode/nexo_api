import { signal } from '@angular/core';
import { WorkspaceState, success } from './workspace-state';
import { DialogAnswer, DialogRequest } from './mongo-dialog';
import { ResultsEdit } from './mongo-results';
import type { MongoUseCases, QueryTarget, WriteAnswer } from '../application/mongo-use-cases';
import { WorkspaceDocument } from '../domain/models';
import { shell } from '../domain/bson';
import {
  WriteConcernChoice,
  WriteTextError,
  collectionOptions,
  dottedPath,
  duplicate,
  idFilter,
  parseDocuments,
  parseUpdate,
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

/**
 * Writes of the MongoDB explorer, each through a dialog that says what will happen: fields
 * and documents edited, inserted, duplicated and deleted, writes to many documents after
 * counting them, collections and databases created, renamed, emptied and dropped, and
 * recorded changes undone. The backend checks the same rules again.
 */
export class MongoWrites {
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

  constructor(private readonly context: WriteContext) {}

  private get scope() {
    const { state, connection } = this.context;
    return [state.workspaceId(), connection(), state.scopes()] as const;
  }
  private where() {
    const target = this.context.target();
    if (!target) throw new Error('Choose a collection');
    const concern = writeConcern(this.concern());
    return { ...target, ...(concern ? { writeConcern: concern } : {}) };
  }

  private ask(request: DialogRequest, action: Action) {
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
  private async written(answer: WriteAnswer) {
    const cases = await this.context.cases();
    this.context.state.applySaved([await cases.change(answer.change)]);
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
                await cases.update(
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
                await cases.replace(...this.scope, this.where(), filter(), replacement),
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
              await cases.update(...this.scope, this.where(), filter(), unsetField(path)),
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
            await this.written(await cases.deleteDocuments(...this.scope, this.where(), filter()));
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
        const answer = await cases.insert(...this.scope, this.where(), parseDocuments(text));
        await this.written(answer);
        return 'Documents inserted';
      },
    );
  }

  /** How many documents the query bar's filter matches now. */
  private async count(filter: Record<string, unknown>) {
    const cases = await this.context.cases();
    const target = this.context.target();
    if (!target) throw new Error('Choose a collection');
    return cases.count(...this.scope, target, { filter }, crypto.randomUUID());
  }
  /** Updates every document the filter matches, after counting them. */
  updateMany() {
    this.run(() => this.countThenUpdate());
  }
  private async countThenUpdate() {
    const filter = this.context.filter();
    if (!filter) return;
    const count = await this.count(filter);
    this.ask(
      {
        title: 'Update many documents',
        message: { key: 'mongo.willUpdate', params: { v0: count } },
        editor: { label: 'Update', value: "{ $set: { field: 'value' } }" },
        confirm: 'Update documents',
        danger: true,
      },
      async ({ text }) => {
        const cases = await this.context.cases();
        const answer = await cases.update(
          ...this.scope,
          this.where(),
          filter,
          parseUpdate(text),
          count,
        );
        await this.written(answer);
        return 'Documents updated';
      },
    );
  }

  /** Deletes every document the filter matches, after counting them. */
  deleteMany(everything = false) {
    this.run(() => this.countThenDelete(everything));
  }
  private async countThenDelete(everything: boolean) {
    const filter = everything ? {} : this.context.filter();
    if (!filter) return;
    const count = await this.count(filter);
    const collection = this.context.target()?.collection ?? '';
    const all = !Object.keys(filter).length;
    this.ask(
      {
        title: all ? 'Empty collection' : 'Delete many documents',
        message: { key: 'mongo.willDelete', params: { v0: count } },
        ...(all ? { confirmName: collection } : {}),
        confirm: 'Delete documents',
        danger: true,
      },
      async () => {
        const cases = await this.context.cases();
        const answer = await cases.deleteDocuments(...this.scope, this.where(), filter, {
          expected: count,
          ...(all ? { confirm: collection } : {}),
        });
        await this.written(answer);
        return 'Documents deleted';
      },
    );
  }

  /** A new collection, in `database` or in a new database. */
  newCollection(database?: string) {
    this.ask(
      {
        title: database ? 'New collection' : 'New database',
        message: database
          ? { key: 'mongo.inDatabase', params: { v0: database } }
          : { key: 'A database is created with its first collection.' },
        ...(database ? {} : { first: { label: 'Database name', value: '' } }),
        second: { label: 'Collection name', value: '' },
        collectionOptions: true,
        confirm: 'Create',
      },
      async ({ first, second, options }) => {
        const name = (database ?? first).trim();
        const collection = second.trim();
        if (!name || !collection) throw new WriteTextError('Write the names');
        const cases = await this.context.cases();
        await cases.createCollection(
          ...this.scope,
          { database: name, collection },
          collectionOptions(options),
        );
        if (!database) await this.context.reloadDatabases();
        await this.context.reloadCollections(name);
        await this.context.choose(name, collection);
        return 'Collection created';
      },
    );
  }

  rename() {
    const target = this.context.target();
    if (!target) return;
    this.ask(
      {
        title: 'Rename collection',
        first: { label: 'New name', value: target.collection },
        confirm: 'Rename',
      },
      async ({ first }) => {
        const to = first.trim();
        if (!to || to === target.collection) throw new WriteTextError('Write the new name');
        const cases = await this.context.cases();
        await cases.renameCollection(...this.scope, target, to);
        await this.context.reloadCollections(target.database);
        await this.context.choose(target.database, to);
        return 'Collection renamed';
      },
    );
  }

  dropCollection() {
    const target = this.context.target();
    if (!target) return;
    this.ask(
      {
        title: 'Drop collection',
        message: {
          key: 'mongo.dropping',
          params: { v0: `${target.database}.${target.collection}` },
        },
        confirmName: target.collection,
        confirm: 'Drop collection',
        danger: true,
      },
      async () => {
        const cases = await this.context.cases();
        await cases.dropCollection(...this.scope, target, target.collection);
        await this.context.reloadCollections(target.database);
        await this.context.choose(target.database);
        return 'Collection dropped';
      },
    );
  }

  dropDatabase() {
    const database = this.context.target()?.database;
    if (!database) return;
    this.ask(
      {
        title: 'Drop database',
        message: { key: 'mongo.dropping', params: { v0: database } },
        confirmName: database,
        confirm: 'Drop database',
        danger: true,
      },
      async () => {
        const cases = await this.context.cases();
        await cases.dropDatabase(...this.scope, database, database);
        await this.context.reloadDatabases();
        await this.context.choose(database);
        return 'Database dropped';
      },
    );
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
        await this.written(await cases.undo(...this.scope, change.id));
        return 'Change undone';
      },
    );
  }

  /** Runs an action that may fail before its dialog opens (a count), showing why. */
  private run(action: () => Promise<void>) {
    void action().catch((error: unknown) => this.context.fail(error));
  }
}
