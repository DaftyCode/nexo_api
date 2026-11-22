/**
 * A MongoDB connection in the navigator of the databases (DB-39): its databases, and in each
 * one its collections, views, time series collections and GridFS buckets, as nodes of the
 * same tree as the SQL connections', as the MongoDB module's driver answers them.
 */
import type { DbNode } from '../db/tree';
import type { CollectionSummary, DatabaseSummary } from '../mongo-query';

/** The databases MongoDB itself keeps: the simple view hides them, as Compass groups them. */
const SYSTEM_DATABASES = ['admin', 'config', 'local'];

export function databaseNodes(databases: readonly DatabaseSummary[]): DbNode[] {
  return databases.map((database) => ({
    kind: 'database',
    name: database.name,
    label: database.name,
    hasChildren: true,
    actions: ['open'],
    ...(SYSTEM_DATABASES.includes(database.name) ? { system: true } : {}),
  }));
}

/** The kind of node a collection is: a file of a GridFS bucket, a view, a time series. */
function collectionKind(collection: CollectionSummary): string {
  if (collection.gridfs) return 'gridfs';
  return collection.kind;
}

export function collectionNodes(collections: readonly CollectionSummary[]): DbNode[] {
  return collections.map((collection) => {
    const detail = collection.viewOn ? `→ ${collection.viewOn}` : collection.gridfs;
    return {
      kind: collectionKind(collection),
      name: collection.name,
      label: collection.name,
      ...(detail ? { detail } : {}),
      hasChildren: false,
      actions: ['open'],
      ...(collection.name.startsWith('system.') ? { system: true } : {}),
    };
  });
}
