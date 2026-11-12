/**
 * Whole programs of the dynamic languages (mongosh, Node.js, Python, PHP, Ruby); the typed
 * ones are in `programs-typed.ts`.
 */
import type { CodeQuery } from '../mongo-codegen';
import { TYPED_PROGRAMS } from './programs-typed';
import { CodeLanguage, ValueWriter, quote } from './values';

export type Program = (query: CodeQuery, writer: ValueWriter) => string;
type Plain = Record<string, unknown>;

/** The options of a query that are set, by name, in a fixed order. */
export function findOptions(query: CodeQuery): [string, unknown][] {
  if (query.kind === 'aggregate')
    return (
      [
        ['allowDiskUse', query.allowDiskUse || undefined],
        ['collation', query.collation],
        ['hint', query.hint],
        ['maxTimeMS', query.maxTimeMS],
      ] as [string, unknown][]
    ).filter(([, value]) => value !== undefined);
  return (
    [
      ['projection', query.projection],
      ['sort', query.sort],
      ['collation', query.collation],
      ['hint', query.hint],
      ['skip', query.skip],
      ['limit', query.limit],
    ] as [string, unknown][]
  ).filter(([, value]) => value !== undefined);
}

const json = JSON.stringify;

const mongosh: Program = (query, writer) => {
  const target = `db.getSiblingDB(${json(query.database)}).getCollection(${json(query.collection)})`;
  if (query.kind === 'aggregate') {
    const options = Object.fromEntries(findOptions(query));
    const extra = Object.keys(options).length ? `, ${writer.value(options, 0)}` : '';
    return `printjson(\n  ${target}\n    .aggregate(${writer.value(query.pipeline, 2)}${extra})\n    .toArray()\n);\n`;
  }
  const chain = [
    `.find(${writer.value(query.filter ?? {}, 2)}${query.projection ? `, ${writer.value(query.projection, 2)}` : ''})`,
  ];
  for (const [name, value] of findOptions(query))
    if (name !== 'projection') chain.push(`.${name}(${writer.value(value, 2)})`);
  return `printjson(\n  ${target}\n    ${chain.join('\n    ')}\n    .toArray()\n);\n`;
};

const node: Program = (query, writer) => {
  const options = Object.fromEntries(findOptions(query));
  const extra = Object.keys(options).length ? `, ${writer.value(options, 2)}` : '';
  const call =
    query.kind === 'aggregate'
      ? `.aggregate(${writer.value(query.pipeline, 2)}${extra})`
      : `.find(${writer.value(query.filter ?? {}, 2)}${extra})`;
  const imports = ['MongoClient', ...writer.uses].sort().join(', ');
  return `import { ${imports} } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
try {
  const collection = client.db(${json(query.database)}).collection(${json(query.collection)});
  const documents = await collection
    ${call}
    .toArray();
  console.log(documents);
} finally {
  await client.close();
}
`;
};

/** A sort or index hint as PyMongo wants it: a list of (field, direction) pairs. */
function pairs(document: Plain, writer: ValueWriter): string {
  const items = Object.entries(document).map(
    ([key, value]) => `(${json(key)}, ${writer.value(value, 2)})`,
  );
  return `[${items.join(', ')}]`;
}

const python: Program = (query, writer) => {
  const names: Record<string, string> = { allowDiskUse: 'allowDiskUse', maxTimeMS: 'maxTimeMS' };
  const options = findOptions(query).map(([name, value]) => {
    const text =
      (name === 'sort' || name === 'hint') && typeof value === 'object'
        ? pairs(value as Plain, writer)
        : typeof value === 'boolean'
          ? value
            ? 'True'
            : 'False'
          : writer.value(value, 1);
    return `    ${names[name] ?? name}=${text},`;
  });
  const first =
    query.kind === 'aggregate'
      ? writer.value(query.pipeline, 1)
      : writer.value(query.filter ?? {}, 1);
  const method = query.kind === 'aggregate' ? 'aggregate' : 'find';
  const uses = writer.uses;
  const lines = ['import os'];
  if (uses.has('Binary')) lines.push('import base64');
  if (uses.has('datetime')) lines.push('from datetime import datetime');
  if (uses.has('UUID')) lines.push('from uuid import UUID');
  const bson = [...uses].filter((name) => !['datetime', 'UUID'].includes(name)).sort();
  if (bson.length) lines.push(`from bson import ${bson.join(', ')}`);
  lines.push('from pymongo import MongoClient');
  return `${lines.join('\n')}

client = MongoClient(os.environ["MONGODB_URI"], uuidRepresentation="standard")
collection = client[${json(query.database)}][${json(query.collection)}]
documents = collection.${method}(
    ${first},
${options.join('\n')}${options.length ? '\n' : ''})
for document in documents:
    print(document)
`;
};

const php: Program = (query, writer) => {
  const options = findOptions(query);
  const first =
    query.kind === 'aggregate'
      ? writer.value(query.pipeline, 0)
      : writer.value(query.filter ?? {}, 0);
  const extra = options.length ? `, ${writer.value(Object.fromEntries(options), 0)}` : '';
  const method = query.kind === 'aggregate' ? 'aggregate' : 'find';
  const uses = [...writer.uses]
    .sort()
    .map((name) => `use MongoDB\\BSON\\${name};\n`)
    .join('');
  return `<?php
require __DIR__ . '/vendor/autoload.php';

${uses}use MongoDB\\Client;

$client = new Client(getenv('MONGODB_URI'));
$collection = $client->selectCollection(${quote('php', query.database)}, ${quote('php', query.collection)});
$documents = $collection->${method}(${first}${extra});
foreach ($documents as $document) {
    echo json_encode($document), PHP_EOL;
}
`;
};

const ruby: Program = (query, writer) => {
  const names: Record<string, string> = {
    allowDiskUse: 'allow_disk_use',
    maxTimeMS: 'max_time_ms',
  };
  const options = findOptions(query).map(
    ([name, value]) => `${names[name] ?? name}: ${writer.value(value, 1)}`,
  );
  const first =
    query.kind === 'aggregate'
      ? writer.value(query.pipeline, 0)
      : writer.value(query.filter ?? {}, 0);
  const method = query.kind === 'aggregate' ? 'aggregate' : 'find';
  const requires = writer.uses.has('base64') ? "require 'base64'\n" : '';
  return `require 'mongo'
${requires}
client = Mongo::Client.new(ENV.fetch('MONGODB_URI'))
collection = client.use(${quote('ruby', query.database)})[${quote('ruby', query.collection)}]
documents = collection.${method}(${[first, ...options].join(', ')})
documents.each { |document| puts document.inspect }
client.close
`;
};

export const PROGRAMS: Record<CodeLanguage, Program> = {
  mongosh,
  node,
  python,
  php,
  ruby,
  ...TYPED_PROGRAMS,
};
