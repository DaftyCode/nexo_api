/** What scripts can ask of the databases: `nx.mongo` and `nx.sql` (DB-32). */
import { method, type ScriptMember } from './members';

/** What a collection of `nx.mongo(name).db(database).collection(name)` can do. */
const MONGO_COLLECTION: ScriptMember[] = [
  method('findOne', '(filter?, options?) → Promise', 'The first document that matches, or null.'),
  method(
    'find',
    '(filter?, options?) → cursor',
    'Documents that match: sort, limit, skip, project, then toArray() (1 000 at most).',
  ),
  method('countDocuments', '(filter?) → Promise', 'How many documents match.'),
  method(
    'aggregate',
    '(pipeline, options?) → cursor',
    'An aggregation that reads; toArray() gives its documents.',
  ),
  method(
    'insertOne',
    '(document) → Promise',
    'Inserts a document; refused on a read-only connection.',
  ),
  method('insertMany', '(documents) → Promise', 'Inserts several documents.'),
  method('updateOne', '(filter, update) → Promise', 'Updates the first document that matches.'),
  method('updateMany', '(filter, update) → Promise', 'Updates every document that matches.'),
  method('replaceOne', '(filter, document) → Promise', 'Replaces the first document that matches.'),
  method('deleteOne', '(filter) → Promise', 'Deletes the first document that matches.'),
  method(
    'deleteMany',
    '(filter, options?) → Promise',
    'Deletes every match; an empty filter needs { confirm: collection }.',
  ),
];
export const MONGO_DATABASE = method('db', '(name) → database', 'A database of the connection.', [
  method('collection', '(name) → collection', 'A collection of the database.', MONGO_COLLECTION),
  method('getCollection', '(name) → collection', 'The same as collection.', MONGO_COLLECTION),
]);

/** What `nx.sql(name)` can do (DB-32): parameters always bound, every rule of the editor. */
export const SQL_CLIENT: ScriptMember[] = [
  method(
    'query',
    '(sql, params?, options?) → Promise<rows>',
    'Rows as objects by column (1 000 at most; rows.truncated says if it was cut).',
  ),
  method('queryOne', '(sql, params?, options?) → Promise', 'The first row, or null.'),
  method(
    'execute',
    '(sql, params?, options?) → Promise',
    'Runs a change: { affected, rows }. What asks to confirm needs { confirm: true } or { confirm: name }.',
  ),
  method(
    'transaction',
    '(async (tx) => …) → Promise',
    'Runs the function in a transaction: committed when it ends, undone if it throws.',
  ),
];
export const SQL_HELPERS: ScriptMember[] = [
  method('numeric', '(text) → value', 'A decimal parameter, written as text so nothing is lost.'),
  method('bytes', '(bytes | base64) → value', 'A binary parameter.'),
  method('typed', '(kind, text) → value', 'A parameter of a kind: uuid, date, interval…'),
];
