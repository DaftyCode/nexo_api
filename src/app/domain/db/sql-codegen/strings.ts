/**
 * A statement as a string literal of each language, well escaped, on several lines where the
 * language has a form for them (DBeaver's «Copy as source code»), and the other way round:
 * the text of the literals pasted from a program, its quotes and concatenations taken away.
 */
import type { CodeValue, SqlCodeLanguage } from './common';

/** The languages with string literals: every program's but the command line. */
export type StringLanguage = Exclude<SqlCodeLanguage, 'cli'>;

const control = (char: string) => char.charCodeAt(0).toString(16).padStart(4, '0');
/** Escapes as JSON, which C#, Go, Java, JavaScript and Python read alike. */
const quoted = (text: string) => JSON.stringify(text);
const single = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function rust(text: string, multiline: boolean): string {
  if (multiline) {
    let hashes = '#';
    while (text.includes(`"${hashes}`)) hashes += '#';
    return `r${hashes}"${text}"${hashes}`;
  }
  const known: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
  };
  const escaped = [...text]
    .map((char) => known[char] ?? (char < ' ' ? `\\u{${control(char)}}` : char))
    .join('');
  return `"${escaped}"`;
}

/** A string literal of `language`; `multiline` uses the language's form for several lines. */
export function literal(
  language: StringLanguage,
  text: string,
  multiline = text.includes('\n'),
): string {
  switch (language) {
    case 'node':
      return multiline
        ? `\`${text
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${')
            .replace(/\r/g, '\\r')}\``
        : single(text).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    case 'python':
      return multiline
        ? `"""${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r')}"""`
        : quoted(text);
    case 'java': {
      if (!multiline) return quoted(text);
      const parts = text.split('\n');
      return parts
        .map((part, at) => quoted(at < parts.length - 1 ? `${part}\n` : part))
        .filter((part) => part !== '""')
        .join(' +\n    ');
    }
    case 'csharp':
      // A carriage return in the source would not survive editors: it goes escaped.
      return multiline && !text.includes('\r') ? `@"${text.replace(/"/g, '""')}"` : quoted(text);
    case 'go':
      return multiline && !/[`\r]/.test(text) ? `\`${text}\`` : quoted(text);
    case 'rust':
      return rust(text, multiline && !text.includes('\r'));
    case 'php':
    case 'ruby':
      return single(text);
  }
}

/** A parameter's value as a literal of `language`. */
export function valueLiteral(language: StringLanguage, value: CodeValue): string {
  if (value === null) {
    const nulls: Record<StringLanguage, string> = {
      node: 'null',
      python: 'None',
      java: 'null',
      csharp: 'DBNull.Value',
      go: 'nil',
      rust: 'None::<String>',
      php: 'null',
      ruby: 'nil',
    };
    return nulls[language];
  }
  if (typeof value === 'boolean') {
    if (language === 'python') return value ? 'True' : 'False';
    return String(value);
  }
  if (typeof value === 'number') {
    if (language === 'java' && Number.isInteger(value) && Math.abs(value) > 2 ** 31 - 1)
      return `${value}L`;
    return String(value);
  }
  return literal(language, value, false);
}

/** The escapes of a double-quoted literal. */
function unescape(body: string): string {
  return body.replace(
    /\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|[\s\S])/g,
    (_, all: string, braced?: string, unicode?: string, hex?: string) => {
      const code = braced ?? unicode ?? hex;
      if (code) return String.fromCodePoint(parseInt(code, 16));
      const known: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        '0': '\0',
      };
      return known[all] ?? all;
    },
  );
}

/**
 * The text of the string literals in a piece of a program, joined: `"a" + "b"`, `'a' . 'b'`,
 * adjacent literals, template literals, triple quotes, `@"…"` and `r#"…"#`. Text without
 * literals comes back as it is.
 */
export function pasteFromCode(code: string): string {
  const pattern =
    /(?<![\w])r(#*)"([\s\S]*?)"\1|@"((?:[^"]|"")*)"|"""((?:\\[\s\S]|(?!""")[^\\])*)"""|'''((?:\\[\s\S]|(?!''')[^\\])*)'''|`((?:\\[\s\S]|[^`\\])*)`|"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    const [, , raw, verbatim, triple, tripleSingle, template, double, single] = match;
    if (raw !== undefined) parts.push(raw);
    else if (verbatim !== undefined) parts.push(verbatim.replace(/""/g, '"'));
    else if (triple !== undefined) parts.push(unescape(triple));
    else if (tripleSingle !== undefined) parts.push(unescape(tripleSingle));
    else if (template !== undefined)
      parts.push(
        template.replace(/\\([`\\$r])/g, (_, char: string) => (char === 'r' ? '\r' : char)),
      );
    else if (double !== undefined) parts.push(unescape(double));
    else if (single !== undefined) parts.push(single.replace(/\\([\\'])/g, '$1'));
  }
  return parts.length ? parts.join('') : code;
}
