import { WriteTextError, collectionOptions } from '../domain/mongo-write';
import type { WriteDialog } from './mongo-writes';

/** A new collection, in `database` or in a new database. */
export function newCollection(dialog: WriteDialog, database?: string) {
  dialog.ask(
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
      const cases = await dialog.context.cases();
      await cases.writes.createCollection(
        ...dialog.scope,
        { database: name, collection },
        collectionOptions(options),
      );
      if (!database) await dialog.context.reloadDatabases();
      await dialog.context.reloadCollections(name);
      await dialog.context.choose(name, collection);
      return 'Collection created';
    },
  );
}

/** Renames the chosen collection. */
export function renameCollection(dialog: WriteDialog) {
  const target = dialog.context.target();
  if (!target) return;
  dialog.ask(
    {
      title: 'Rename collection',
      first: { label: 'New name', value: target.collection },
      confirm: 'Rename',
    },
    async ({ first }) => {
      const to = first.trim();
      if (!to || to === target.collection) throw new WriteTextError('Write the new name');
      const cases = await dialog.context.cases();
      await cases.writes.renameCollection(...dialog.scope, target, to);
      await dialog.context.reloadCollections(target.database);
      await dialog.context.choose(target.database, to);
      return 'Collection renamed';
    },
  );
}

/** Drops the chosen collection; its name is typed to confirm. */
export function dropCollection(dialog: WriteDialog) {
  const target = dialog.context.target();
  if (!target) return;
  dialog.ask(
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
      const cases = await dialog.context.cases();
      await cases.writes.dropCollection(...dialog.scope, target, target.collection);
      await dialog.context.reloadCollections(target.database);
      await dialog.context.choose(target.database);
      return 'Collection dropped';
    },
  );
}

/** Drops the database of the chosen collection; its name is typed to confirm. */
export function dropDatabase(dialog: WriteDialog) {
  const database = dialog.context.target()?.database;
  if (!database) return;
  dialog.ask(
    {
      title: 'Drop database',
      message: { key: 'mongo.dropping', params: { v0: database } },
      confirmName: database,
      confirm: 'Drop database',
      danger: true,
    },
    async () => {
      const cases = await dialog.context.cases();
      await cases.writes.dropDatabase(...dialog.scope, database, database);
      await dialog.context.reloadDatabases();
      await dialog.context.choose(database);
      return 'Database dropped';
    },
  );
}
