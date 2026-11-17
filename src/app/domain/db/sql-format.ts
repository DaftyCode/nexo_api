/**
 * Formatting SQL, as DBeaver's formatter: by tokens, so only the spaces between them and the
 * case of keywords change, never what the statement means. Each clause starts a line, the
 * columns of a `SELECT` and the conditions of a `WHERE` go one per line, a subquery is
 * indented, and comments stay where they were.
 */

export interface FormatOptions {
  keywords: 'upper' | 'lower' | 'keep';
  indent: string;
  /** Commas at the start of the next line instead of the end of this one. */
  commaFirst: boolean;
}
export const DEFAULT_FORMAT: FormatOptions = { keywords: 'upper', indent: '  ', commaFirst: false };

/** Words that start a clause on a line of their own. */
const CLAUSES = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INSERT',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'RETURNING',
  'WITH',
  'WINDOW',
  'FETCH',
]);
/** Words that start a join, on a line of their own. */
const JOINS = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL']);
const KEYWORDS = new Set([
  ...CLAUSES,
  ...JOINS,
  'AS',
  'ON',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS',
  'IN',
  'LIKE',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'BY',
  'ASC',
  'DESC',
  'DISTINCT',
  'ALL',
  'INTO',
  'OUTER',
  'EXISTS',
  'TRUE',
  'FALSE',
  'USING',
  'OVER',
  'PARTITION',
  'ROWS',
  'FIRST',
  'NEXT',
  'ONLY',
  'CREATE',
  'TABLE',
  'VIEW',
  'INDEX',
  'DROP',
  'ALTER',
  'ADD',
  'PRIMARY',
  'KEY',
  'FOREIGN',
  'REFERENCES',
  'DEFAULT',
  'CONSTRAINT',
  'UNIQUE',
  'CHECK',
  'IF',
  'TOP',
  'ILIKE',
]);

export interface FormatToken {
  text: string;
  kind: 'space' | 'comment' | 'string' | 'quoted' | 'word' | 'symbol';
}

/** The tokens of SQL text, whitespace included. */
export function formatTokens(sql: string): FormatToken[] {
  const pattern =
    /(\s+)|(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?|\$\$[\s\S]*?(?:\$\$|$))|("(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?)|([A-Za-z_][\w$]*|\d+(?:\.\d+)?(?:e[-+]?\d+)?)|(<=|>=|<>|!=|\|\||::|:=|=>|->>|->|.)/gy;
  const kinds = ['space', 'comment', 'string', 'quoted', 'word', 'symbol'] as const;
  const found: FormatToken[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) && match[0]) {
    const at = match.slice(1).findIndex((group) => group !== undefined);
    found.push({ text: match[0], kind: kinds[at] });
  }
  return found;
}

/** The tokens that carry meaning, keywords in one case: what formatting must keep. */
export function meaning(sql: string): string[] {
  return formatTokens(sql)
    .filter((token) => token.kind !== 'space')
    .map((token) =>
      token.kind === 'word' && KEYWORDS.has(token.text.toUpperCase())
        ? token.text.toUpperCase()
        : token.text.trim(),
    );
}

/** The SQL laid out by clauses; formatting it again gives the same text. */
export function formatSql(sql: string, options: FormatOptions = DEFAULT_FORMAT): string {
  const list = formatTokens(sql).filter((token) => token.kind !== 'space');
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  /** Parentheses opened, and whether each one holds a subquery. */
  const parens: boolean[] = [];
  let clause = '';
  const pad = () => options.indent.repeat(depth);
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    line = '';
  };
  const newline = (extra = 0) => {
    flush();
    line = pad() + options.indent.repeat(extra);
  };
  const add = (text: string, space = true) => {
    const glue = !line.trim() || !space || /[.(\s]$/.test(line) ? '' : ' ';
    line += glue + text;
  };
  for (const [index, token] of list.entries()) {
    const word = token.kind === 'word' ? token.text.toUpperCase() : '';
    const text =
      token.kind === 'word' && KEYWORDS.has(word) && options.keywords !== 'keep'
        ? options.keywords === 'upper'
          ? word
          : token.text.toLowerCase()
        : token.text;
    const previous = list[index - 1];
    const previousWord = previous?.kind === 'word' ? previous.text.toUpperCase() : '';
    if (token.kind === 'comment') {
      add(text);
      if (text.startsWith('--')) newline();
      continue;
    }
    if (word && CLAUSES.has(word) && !(word === 'SET' && clause === 'UPDATE' && false)) {
      const continued =
        (word === 'BY' && ['GROUP', 'ORDER'].includes(previousWord)) ||
        (word === 'ALL' && previousWord === 'UNION') ||
        (word === 'FROM' && previousWord === 'DELETE') ||
        (word === 'INTO' && previousWord === 'INSERT');
      if (!continued && (line.trim() || lines.length)) newline();
      clause = word;
      add(text);
      if (word === 'SELECT') newline(1);
      continue;
    }
    if (word && JOINS.has(word) && !JOINS.has(previousWord)) {
      newline();
      add(text);
      continue;
    }
    if (
      (word === 'AND' || word === 'OR') &&
      (clause === 'WHERE' || clause === 'HAVING') &&
      !parens.length
    ) {
      newline(1);
      add(text);
      continue;
    }
    if (token.text === '(') {
      const subquery = list[index + 1]?.text.toUpperCase() === 'SELECT';
      // A function's parenthesis touches its name; any other is spaced.
      add(text, !(previous?.kind === 'word' && !KEYWORDS.has(previousWord)));
      parens.push(subquery);
      if (subquery) {
        depth++;
        newline();
      }
      continue;
    }
    if (token.text === ')') {
      const subquery = parens.pop();
      if (subquery) {
        depth = Math.max(0, depth - 1);
        newline();
        line += ')';
        continue;
      }
      add(text, false);
      continue;
    }
    if (token.text === ',') {
      if (clause === 'SELECT' && !parens.length) {
        if (options.commaFirst) {
          newline();
          line = pad() + ', ';
        } else {
          add(',', false);
          newline(1);
        }
        continue;
      }
      add(',', false);
      continue;
    }
    if (token.text === ';') {
      add(';', false);
      newline();
      clause = '';
      continue;
    }
    const tight = ['.', '::'];
    add(text, !(tight.includes(token.text) || tight.includes(previous?.text ?? '')));
  }
  flush();
  return lines.join('\n');
}
