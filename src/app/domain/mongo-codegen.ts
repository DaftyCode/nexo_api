/**
 * Driver code for a query or an aggregation: a whole program for mongosh, Node.js, Python,
 * Java, C#, Go, Rust, PHP or Ruby that connects with the `MONGODB_URI` environment variable
 * (never the connection's URI or password) and prints what the query finds. Values keep
 * their BSON types in each driver.
 */
import { PROGRAMS } from './mongo-codegen/programs';
import { TYPED_WRITERS } from './mongo-codegen/typed';
import { CodeLanguage, ValueWriter } from './mongo-codegen/values';
import { DYNAMIC_WRITERS } from './mongo-codegen/writers';

export { CodegenError, type CodeLanguage } from './mongo-codegen/values';

/** The languages offered, with the file a program is saved as. */
export const CODE_LANGUAGES: { id: CodeLanguage; label: string; file: string }[] = [
  { id: 'mongosh', label: 'mongosh', file: 'query.js' },
  { id: 'node', label: 'Node.js', file: 'query.mjs' },
  { id: 'python', label: 'Python (PyMongo)', file: 'query.py' },
  { id: 'java', label: 'Java', file: 'Query.java' },
  { id: 'csharp', label: 'C#', file: 'Query.cs' },
  { id: 'go', label: 'Go', file: 'main.go' },
  { id: 'rust', label: 'Rust', file: 'main.rs' },
  { id: 'php', label: 'PHP', file: 'query.php' },
  { id: 'ruby', label: 'Ruby', file: 'query.rb' },
];

type Plain = Record<string, unknown>;

/** What the code runs, in canonical (or shell-read) Extended JSON. */
export type CodeQuery = {
  database: string;
  collection: string;
} & (
  | {
      kind: 'find';
      filter?: Plain;
      projection?: Plain;
      sort?: Plain;
      collation?: Plain;
      hint?: string | Plain;
      skip?: number;
      limit?: number;
    }
  | {
      kind: 'aggregate';
      pipeline: Plain[];
      allowDiskUse?: boolean;
      collation?: Plain;
      hint?: string | Plain;
      maxTimeMS?: number;
    }
);

export function valueWriter(language: CodeLanguage): ValueWriter {
  const make = DYNAMIC_WRITERS[language] ?? TYPED_WRITERS[language];
  if (!make) throw new Error(`No writer for ${language}`);
  return make();
}

/** A whole program that runs the query and prints its documents. */
export function generateCode(language: CodeLanguage, query: CodeQuery): string {
  return PROGRAMS[language](query, valueWriter(language));
}
