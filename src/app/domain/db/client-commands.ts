/**
 * The client commands of a script, as DBeaver's: lines that begin with `@` are done by the
 * editor, not sent to the server. `@set name = value` and `@unset name` keep variables used as
 * `${name}`; `@echo text` writes a message; `@include name` runs a saved script of the
 * workspace (never a file of the disk); `@export` sends the next result to a file. Any other
 * `@` is refused with its name.
 */

export type ClientCommand =
  | { kind: 'set'; name: string; value: string }
  | { kind: 'unset'; name: string }
  | { kind: 'echo'; text: string }
  | { kind: 'include'; script: string }
  | { kind: 'export'; options: string };

/** A piece of a script: SQL to split and run, or a client command, with where it starts. */
export type ScriptPart =
  | { kind: 'sql'; text: string; offset: number }
  | { kind: 'command'; command: ClientCommand; offset: number; line: number };

const NAME = /^[A-Za-z_][\w.]*$/;

/** A command line, or an error that names what is wrong with it. */
export function readCommand(
  line: string,
): ClientCommand | { error: string; params?: Record<string, string> } {
  const text = line.trim().slice(1);
  const [word = ''] = text.split(/\s/, 1);
  const rest = text.slice(word.length).trim();
  switch (word.toLowerCase()) {
    case 'set': {
      const equals = rest.indexOf('=');
      const name = (equals < 0 ? rest : rest.slice(0, equals)).trim();
      if (!NAME.test(name) || equals < 0) return { error: 'db.client.set' };
      let value = rest.slice(equals + 1).trim();
      if (/^'.*'$/.test(value)) value = value.slice(1, -1).replaceAll("''", "'");
      return { kind: 'set', name, value };
    }
    case 'unset':
      return NAME.test(rest) ? { kind: 'unset', name: rest } : { error: 'db.client.unset' };
    case 'echo':
      return { kind: 'echo', text: rest };
    case 'include':
      // A saved script of the workspace, by its name: never a path of the disk.
      if (!rest || /[\\/:]|\.\./.test(rest)) return { error: 'db.client.include' };
      return { kind: 'include', script: rest.replace(/^'(.*)'$/, '$1') };
    case 'export':
      return { kind: 'export', options: rest };
    default:
      return { error: 'db.client.unknown', params: { v0: `@${word}` } };
  }
}

/** The script cut into SQL and client commands, in order. */
export function scriptParts(script: string): ScriptPart[] {
  const parts: ScriptPart[] = [];
  let offset = 0;
  let sql = '';
  let sqlStart = 0;
  const lines = script.split('\n');
  for (const [index, line] of lines.entries()) {
    const end = offset + line.length + 1;
    if (line.trim().startsWith('@')) {
      if (sql.trim()) parts.push({ kind: 'sql', text: sql.replace(/\n$/, ''), offset: sqlStart });
      const command = readCommand(line);
      if ('error' in command)
        throw Object.assign(new Error(command.error), { params: command.params, line: index + 1 });
      parts.push({ kind: 'command', command, offset, line: index + 1 });
      sql = '';
      sqlStart = end;
    } else {
      if (!sql) sqlStart = offset;
      sql += `${line}\n`;
    }
    offset = end;
  }
  if (sql.trim()) parts.push({ kind: 'sql', text: sql.replace(/\n$/, ''), offset: sqlStart });
  return parts;
}

/** The text with each `${name}` of the client's variables replaced; a missing one is named. */
export function withClientVariables(sql: string, variables: ReadonlyMap<string, string>): string {
  return sql.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (_, name: string) => {
    const value = variables.get(name);
    if (value === undefined)
      throw Object.assign(new Error('db.client.missing'), { params: { v0: name } });
    return value;
  });
}
