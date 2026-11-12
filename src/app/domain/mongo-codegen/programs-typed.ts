/**
 * Whole programs of the typed languages (Java, C#, Go, Rust). A collation goes in a comment:
 * each of these drivers builds it with a type of its own.
 */
import type { CodeQuery } from '../mongo-codegen';
import type { Program } from './programs';
import { CodeLanguage, quote } from './values';

const json = JSON.stringify;
const collationNote = (query: CodeQuery, prefix: string) =>
  query.collation
    ? `${prefix} Collation ${json(query.collation)}: set it with the driver's Collation type.\n`
    : '';

const java: Program = (query, writer) => {
  const indent = 3;
  const chain: string[] = [];
  let call: string;
  if (query.kind === 'aggregate') {
    call = `collection.aggregate(${writer.value(query.pipeline, indent)})`;
    if (query.allowDiskUse) chain.push('.allowDiskUse(true)');
    if (query.maxTimeMS) chain.push(`.maxTime(${query.maxTimeMS}, TimeUnit.MILLISECONDS)`);
  } else {
    call = `collection.find(${writer.value(query.filter ?? {}, indent)})`;
    if (query.projection) chain.push(`.projection(${writer.value(query.projection, indent)})`);
    if (query.sort) chain.push(`.sort(${writer.value(query.sort, indent)})`);
    if (query.skip) chain.push(`.skip(${query.skip})`);
    if (query.limit) chain.push(`.limit(${query.limit})`);
  }
  if (typeof query.hint === 'string') chain.push(`.hintString(${json(query.hint)})`);
  else if (query.hint) chain.push(`.hint(${writer.value(query.hint, indent)})`);
  const imports = new Set([
    'com.mongodb.client.MongoClient',
    'com.mongodb.client.MongoClients',
    'com.mongodb.client.MongoCollection',
    'org.bson.Document',
    'java.util.ArrayList',
    'java.util.Arrays',
    'java.util.List',
    ...writer.uses,
  ]);
  if (query.kind === 'aggregate' && query.maxTimeMS) imports.add('java.util.concurrent.TimeUnit');
  const lines = [...imports]
    .sort()
    .map((name) => `import ${name};`)
    .join('\n');
  return `${lines}

public class Query {
    public static void main(String[] args) {
        try (MongoClient client = MongoClients.create(System.getenv("MONGODB_URI"))) {
            MongoCollection<Document> collection =
                client.getDatabase(${json(query.database)}).getCollection(${json(query.collection)});
            ${collationNote(query, '//')}List<Document> documents = ${call}
                ${[...chain, '.into(new ArrayList<>());'].join('\n                ')}
            documents.forEach(document -> System.out.println(document.toJson()));
        }
    }
}
`;
};

const csharp: Program = (query, writer) => {
  const lines: string[] = [];
  let call: string;
  if (query.kind === 'aggregate') {
    const stages = query.pipeline.map((stage) => `    ${writer.value(stage, 1)},`).join('\n');
    const options = [
      query.allowDiskUse ? 'AllowDiskUse = true' : '',
      typeof query.hint === 'string'
        ? `Hint = ${json(query.hint)}`
        : query.hint
          ? `Hint = ${writer.value(query.hint, 1)}`
          : '',
      query.maxTimeMS ? `MaxTime = TimeSpan.FromMilliseconds(${query.maxTimeMS})` : '',
    ].filter(Boolean);
    lines.push(
      `PipelineDefinition<BsonDocument, BsonDocument> pipeline = new BsonDocument[]\n{\n${stages}\n};`,
    );
    call = `collection.Aggregate(pipeline${options.length ? `, new AggregateOptions { ${options.join(', ')} }` : ''})`;
  } else {
    const hint =
      typeof query.hint === 'string'
        ? json(query.hint)
        : query.hint
          ? writer.value(query.hint, 1)
          : '';
    call = `collection.Find(${writer.value(query.filter ?? {}, 0)}${hint ? `, new FindOptions { Hint = ${hint} }` : ''})`;
    if (query.projection) call += `\n    .Project(${writer.value(query.projection, 1)})`;
    if (query.sort) call += `\n    .Sort(${writer.value(query.sort, 1)})`;
    if (query.skip) call += `\n    .Skip(${query.skip})`;
    if (query.limit) call += `\n    .Limit(${query.limit})`;
  }
  return `using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient(Environment.GetEnvironmentVariable("MONGODB_URI"));
var collection = client.GetDatabase(${json(query.database)}).GetCollection<BsonDocument>(${json(query.collection)});
${collationNote(query, '//')}${lines.join('\n')}${lines.length ? '\n' : ''}var documents = ${call}
    .ToList();
foreach (var document in documents)
{
    Console.WriteLine(document);
}
`;
};

const go: Program = (query, writer) => {
  const setters: string[] = [];
  let call: string;
  if (query.kind === 'aggregate') {
    call = `collection.Aggregate(context.Background(), ${writer.value(query.pipeline, 1)}, opts)`;
    setters.push('options.Aggregate()');
    if (query.allowDiskUse) setters.push('SetAllowDiskUse(true)');
  } else {
    call = `collection.Find(context.Background(), ${writer.value(query.filter ?? {}, 1)}, opts)`;
    setters.push('options.Find()');
    if (query.projection) setters.push(`SetProjection(${writer.value(query.projection, 1)})`);
    if (query.sort) setters.push(`SetSort(${writer.value(query.sort, 1)})`);
    if (query.skip) setters.push(`SetSkip(${query.skip})`);
    if (query.limit) setters.push(`SetLimit(${query.limit})`);
  }
  if (typeof query.hint === 'string') setters.push(`SetHint(${json(query.hint)})`);
  else if (query.hint) setters.push(`SetHint(${writer.value(query.hint, 1)})`);
  const uses = writer.uses;
  const imports = [
    '"context"',
    ...(uses.has('encoding/base64') ? ['"encoding/base64"'] : []),
    '"fmt"',
    '"os"',
    ...(uses.has('time') ? ['"time"'] : []),
  ];
  const must = uses.has('must')
    ? '\nfunc must[T any](value T, err error) T {\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\treturn value\n}\n'
    : '';
  const note =
    query.kind === 'aggregate' && query.maxTimeMS
      ? `\t// maxTimeMS ${query.maxTimeMS}: give the context a timeout.\n`
      : '';
  return `package main

import (
${imports.map((name) => `\t${name}`).join('\n')}

\t"go.mongodb.org/mongo-driver/v2/bson"
\t"go.mongodb.org/mongo-driver/v2/mongo"
\t"go.mongodb.org/mongo-driver/v2/mongo/options"
)
${must}
func main() {
\tclient, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("MONGODB_URI")))
\tif err != nil {
\t\tpanic(err)
\t}
\tdefer client.Disconnect(context.Background())
\tcollection := client.Database(${json(query.database)}).Collection(${json(query.collection)})
${collationNote(query, '\t//')}${note}\topts := ${setters.join('.\n\t\t')}
\tcursor, err := ${call}
\tif err != nil {
\t\tpanic(err)
\t}
\tvar documents []bson.M
\tif err := cursor.All(context.Background(), &documents); err != nil {
\t\tpanic(err)
\t}
\tfor _, document := range documents {
\t\tfmt.Println(document)
\t}
}
`;
};

const rust: Program = (query, writer) => {
  const chain: string[] = [];
  let call: string;
  const hint = (value: string | Record<string, unknown>) =>
    typeof value === 'string'
      ? `Hint::Name(${quote('rust', value)}.into())`
      : `Hint::Keys(${writer.value(value, 2)})`;
  if (query.kind === 'aggregate') {
    const stages = query.pipeline
      .map((stage) => `            ${writer.value(stage, 3)},`)
      .join('\n');
    call = `.aggregate(vec![\n${stages}\n        ])`;
    if (query.allowDiskUse) chain.push('.allow_disk_use(true)');
    if (query.maxTimeMS)
      chain.push(`.max_time(std::time::Duration::from_millis(${query.maxTimeMS}))`);
  } else {
    call = `.find(${writer.value(query.filter ?? {}, 2)})`;
    if (query.projection) chain.push(`.projection(${writer.value(query.projection, 2)})`);
    if (query.sort) chain.push(`.sort(${writer.value(query.sort, 2)})`);
    if (query.skip) chain.push(`.skip(${query.skip})`);
    if (query.limit) chain.push(`.limit(${query.limit})`);
  }
  if (query.hint) chain.push(`.hint(${hint(query.hint)})`);
  const bson = ['doc', 'Document', ...[...writer.uses].sort()].join(', ');
  const options = query.hint ? ', options::Hint' : '';
  return `use mongodb::{
    bson::{${bson}},
    Client${options},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::with_uri_str(std::env::var("MONGODB_URI")?).await?;
    let collection = client
        .database(${quote('rust', query.database)})
        .collection::<Document>(${quote('rust', query.collection)});
    ${collationNote(query, '//')}let mut cursor = collection
        ${[call, ...chain, '.await?;'].join('\n        ')}
    while cursor.advance().await? {
        println!("{:?}", cursor.deserialize_current()?);
    }
    Ok(())
}
`;
};

export const TYPED_PROGRAMS: Record<
  Extract<CodeLanguage, 'java' | 'csharp' | 'go' | 'rust'>,
  Program
> = {
  java,
  csharp,
  go,
  rust,
};
