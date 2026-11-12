/** Reads the mongo shell syntax of a query: values, constructors and their errors. */

import { construct, numberLiteral, regex } from './values';

/** Why a query field cannot be read, with where. `reason` is a message key. */
export class QuerySyntaxError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
    readonly detail = '',
  ) {
    super(`${reason}${detail ? ` (${detail})` : ''} at line ${line}, column ${column}`);
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const IDENTIFIER = /[A-Za-z0-9_$.]/;
export const INT32 = 2 ** 31;
export const REGEX_OPTIONS = /^[imsxu]*$/;

export class Reader {
  private index = 0;
  constructor(private readonly text: string) {}

  fail(reason: string, detail = '', at = this.index): never {
    const before = this.text.slice(0, at).split('\n');
    throw new QuerySyntaxError(reason, before.length, before[before.length - 1].length + 1, detail);
  }

  /** Skips spaces and comments. */
  private space() {
    for (;;) {
      while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index++;
      if (this.text.startsWith('//', this.index)) {
        const end = this.text.indexOf('\n', this.index);
        this.index = end < 0 ? this.text.length : end;
      } else if (this.text.startsWith('/*', this.index)) {
        const end = this.text.indexOf('*/', this.index + 2);
        if (end < 0) this.fail('Unclosed comment');
        this.index = end + 2;
      } else return;
    }
  }

  private peek() {
    this.space();
    return this.text[this.index] ?? '';
  }

  private expect(char: string) {
    if (this.peek() !== char)
      this.fail(
        this.index < this.text.length ? 'Unexpected character' : 'The text ends too soon',
        `expected ${char}`,
      );
    this.index++;
  }

  /** The whole text as one value. */
  document(): Json {
    const value = this.value();
    if (this.peek()) this.fail('Unexpected character', this.text[this.index]);
    return value;
  }

  private value(): Json {
    const char = this.peek();
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"' || char === "'") return this.string();
    if (char === '/') return this.regex();
    if (/[-+\d.]/.test(char)) return this.number();
    if (/[A-Za-z_$]/.test(char)) return this.word();
    if (!char) this.fail('The text ends too soon', 'expected a value');
    return this.fail('Unexpected character', char);
  }

  private object(): Json {
    this.expect('{');
    const object: Record<string, Json> = {};
    while (this.peek() !== '}') {
      const char = this.peek();
      let key: string;
      if (char === '"' || char === "'") key = this.string();
      else if (IDENTIFIER.test(char)) key = this.identifier();
      else
        return this.fail(
          char ? 'Unexpected character' : 'The text ends too soon',
          char ? char : 'expected }',
        );
      this.expect(':');
      object[key] = this.value();
      this.separator('}');
    }
    this.index++;
    return object;
  }

  private array(): Json[] {
    this.expect('[');
    const items: Json[] = [];
    while (this.peek() !== ']') {
      if (!this.peek()) this.fail('The text ends too soon', 'expected ]');
      items.push(this.value());
      this.separator(']');
    }
    this.index++;
    return items;
  }

  /** After an item: a comma, or the end of the list. */
  private separator(close: string) {
    const char = this.peek();
    if (char === ',') this.index++;
    else if (char !== close)
      this.fail(char ? 'Unexpected character' : 'The text ends too soon', `expected , or ${close}`);
  }

  private identifier(): string {
    this.space();
    const start = this.index;
    while (this.index < this.text.length && IDENTIFIER.test(this.text[this.index])) this.index++;
    return this.text.slice(start, this.index);
  }

  private string(): string {
    const quote = this.peek();
    const start = this.index++;
    let out = '';
    for (;;) {
      const char = this.text[this.index++];
      if (char === undefined || char === '\n') this.fail('Unclosed string', '', start);
      if (char === quote) return out;
      if (char !== '\\') {
        out += char;
        continue;
      }
      const escaped = this.text[this.index++];
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
      };
      if (escaped === 'u' || escaped === 'x') {
        const length = escaped === 'u' ? 4 : 2;
        const hex = this.text.slice(this.index, this.index + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex))
          this.fail('Invalid escape in a string');
        out += String.fromCharCode(parseInt(hex, 16));
        this.index += length;
      } else out += simple[escaped] ?? escaped;
    }
  }

  private regex(): Json {
    const start = this.index++;
    let pattern = '';
    let inClass = false;
    for (;;) {
      const char = this.text[this.index++];
      if (char === undefined || char === '\n') this.fail('Unclosed regular expression', '', start);
      if (char === '\\') {
        pattern += char + (this.text[this.index++] ?? '');
        continue;
      }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      pattern += char;
    }
    const flagsAt = this.index;
    const options = this.identifier();
    if (!REGEX_OPTIONS.test(options))
      this.fail('Unknown regular expression option', options, flagsAt);
    return regex(pattern.replace(/\\\//g, '/'), options);
  }

  private number(): Json {
    const start = this.index;
    const match = /^[-+]?(?:Infinity|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(
      this.text.slice(this.index),
    );
    if (!match) return this.fail('Invalid number', '', start);
    this.index += match[0].length;
    return numberLiteral(match[0]);
  }

  private word(): Json {
    const start = this.index;
    let name = this.identifier();
    if (name === 'new') name = this.identifier();
    switch (name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'undefined':
        return { $undefined: true };
      case 'Infinity':
      case 'NaN':
        return { $numberDouble: name };
    }
    if (this.peek() !== '(') this.fail('Unknown name', name, start);
    this.index++;
    const args: Json[] = [];
    while (this.peek() !== ')') {
      if (!this.peek()) this.fail('The text ends too soon', 'expected )');
      args.push(this.value());
      this.separator(')');
    }
    this.index++;
    try {
      return construct(name, args);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error), name, start);
    }
  }
}
