import { CompletionContext, completionContext } from '../../domain/db/completion';
import { DialectWords, resolve, suggestions } from '../../domain/db/completion-options';
import { SQL_TEMPLATES, SqlTemplate } from '../../domain/db/sql-templates';
import type { SqlAssistSource } from './sql-assist';
import { KnownTable } from './schema-cache';
import type { DbSection } from './section';
import type { SqlRunner } from './sql-runner';

/** The tables a context reads columns of. */
function referenced(context: CompletionContext) {
  switch (context.kind) {
    case 'columns':
      return context.of;
    case 'join':
      return [...context.tables, context.joined];
    case 'star':
    case 'any':
      return context.tables;
    default:
      return [];
  }
}

/**
 * The assistance of a SQL tab: completion from the schema of its connection (read on its
 * session), the columns of a table over its name, opening a table, and the templates.
 */
export function assistFor(
  section: DbSection,
  runner: SqlRunner,
  ownTemplates: () => readonly SqlTemplate[],
): SqlAssistSource {
  const connection = () => runner.connection()?.id ?? '';
  const words = (): DialectWords => {
    const dialect = section.quoteStyle(connection()) as Partial<DialectWords>;
    return {
      quoteOpen: dialect.quoteOpen ?? '"',
      quoteClose: dialect.quoteClose ?? '"',
      keywords: dialect.keywords ?? [],
      functions: dialect.functions ?? [],
    };
  };
  const tables = async (): Promise<KnownTable[]> => {
    if (!(await runner.open())) return [];
    return section.schema.tablesOf(connection(), runner.session, runner.server()?.database);
  };
  const detailed = async (names: readonly { name: string; schema?: string }[]) => {
    const known = await tables();
    const wanted = names
      .map((ref) => resolve(known, ref))
      .filter((table): table is KnownTable => !!table);
    const read = await Promise.all(
      wanted.map((table) => section.schema.detail(connection(), runner.session, table)),
    );
    return known.map((table) => read.find((each) => each.path === table.path) ?? table);
  };
  const find = async (word: string) =>
    resolve(await tables(), { name: word }) as KnownTable | undefined;
  return {
    async complete(statement, cursor) {
      const context = completionContext(statement, cursor);
      if (context.kind === 'none') return [];
      const known = await detailed(referenced(context));
      return suggestions(context, known, words());
    },
    async describe(word) {
      const table = await find(word);
      if (!table) return undefined;
      const read = await section.schema.detail(connection(), runner.session, table);
      const columns = (read.columns ?? []).map((column) => `  ${column.name}  ${column.type}`);
      return [`${read.schema ? `${read.schema}.` : ''}${read.name}`, ...columns].join('\n');
    },
    open(word) {
      void find(word).then((table) => {
        if (table)
          section.tabs.open({
            kind: 'object',
            connection: connection(),
            title: table.name,
            path: table.path,
          });
      });
    },
    templates: () => [...SQL_TEMPLATES, ...ownTemplates()],
  };
}
