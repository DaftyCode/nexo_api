/**
 * Parameters of a statement, as DBeaver asks for them: `:name` (and `?` where the dialect
 * binds with it), never inside strings or comments, nor PostgreSQL's `::` casts or `:=`. The
 * values go bound, written as the dialect binds them, never pasted into the text.
 */

/** A parameter's place in the statement. */
interface Place {
  start: number;
  end: number;
  /** Its name; empty for `?`. */
  name: string;
}

/** The parameters of a statement, in order. `question`: `?` is a parameter too. */
function places(sql: string, question: boolean): Place[] {
  const found: Place[] = [];
  const pattern =
    /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\$(\w*)\$[\s\S]*?\$\1\$|::|:=|:([A-Za-z_]\w*)|(\?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    if (match[2]) found.push({ start: match.index, end: pattern.lastIndex, name: match[2] });
    else if (match[3] && question)
      found.push({ start: match.index, end: pattern.lastIndex, name: '' });
  }
  return found;
}

/** The names of the parameters to ask for, each once, and how many `?` there are. */
export function parametersOf(
  sql: string,
  question: boolean,
): { names: string[]; positional: number } {
  const all = places(sql, question);
  return {
    names: [...new Set(all.filter((place) => place.name).map((place) => place.name))],
    positional: all.filter((place) => !place.name).length,
  };
}

/** How the driver binds a parameter: `$1`, `?` or `@P1`. */
export type ParameterStyle = 'numbered' | 'question' | 'named';

/**
 * The statement with each parameter written as the driver binds it, and the values in the
 * order they bind: a name used twice binds once with `$n` and `@Pn`, twice with `?`.
 */
export function bindParameters(
  sql: string,
  style: ParameterStyle,
  named: Readonly<Record<string, unknown>>,
  positional: readonly unknown[] = [],
): { sql: string; params: unknown[] } {
  const marker = (number: number) =>
    style === 'question' ? '?' : style === 'numbered' ? `$${number}` : `@P${number}`;
  return markParameters(sql, style === 'question', named, positional, {
    marker,
    reuse: style !== 'question',
  });
}

/**
 * The statement with each parameter written by `marker` (given its position from 1), and
 * the values in the order they bind. `reuse`: a name used twice binds once (`$1`, `:1`,
 * `@p1`); otherwise each place binds its own value (`?`, `%s`). `question`: a `?` of the
 * statement is a parameter too.
 */
export function markParameters(
  sql: string,
  question: boolean,
  named: Readonly<Record<string, unknown>>,
  positional: readonly unknown[],
  how: { marker: (position: number) => string; reuse: boolean },
): { sql: string; params: unknown[] } {
  const all = places(sql, question);
  const params: unknown[] = [];
  const numbers = new Map<string, number>();
  let next = 0;
  let text = '';
  let at = 0;
  for (const place of all) {
    text += sql.slice(at, place.start);
    at = place.end;
    const value = place.name ? named[place.name] : positional[next++];
    const key = place.name || `?${next}`;
    let number = how.reuse ? numbers.get(key) : undefined;
    if (number === undefined) {
      params.push(value ?? null);
      number = params.length;
      numbers.set(key, number);
    }
    text += how.marker(number);
  }
  return { sql: text + sql.slice(at), params };
}
