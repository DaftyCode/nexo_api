/**
 * The value writers of each language: documents, arrays and BSON scalars in its syntax.
 */
import { shellText } from '../bson';
import { CodeLanguage, Scalar, ValueWriter, pad, quote, shape } from './values';

/** How a language writes documents, arrays and scalars. */
interface Syntax {
  document(entries: [string, string][], indent: number, nested: boolean): string;
  array(items: string[], indent: number): string;
  scalar(value: Scalar, uses: Set<string>): string;
}

function writer(syntax: Syntax): ValueWriter {
  const uses = new Set<string>();
  const write = (value: unknown, indent: number, nested: boolean): string => {
    const parts = shape(value);
    if (parts.kind === 'scalar') return syntax.scalar(parts.scalar, uses);
    if (parts.kind === 'array')
      return syntax.array(
        parts.items.map((item) => write(item, indent + 1, true)),
        indent,
      );
    return syntax.document(
      parts.entries.map(([key, item]) => [key, write(item, indent + 1, true)]),
      indent,
      nested,
    );
  };
  return { uses, value: (value, indent) => write(value, indent, false) };
}

/** Lines of items between brackets, one per line, or the brackets alone when empty. */
function block(open: string, close: string, lines: string[], indent: number, unit = '  ') {
  if (!lines.length) return `${open}${close}`;
  return `${open}\n${lines.map((line) => `${pad(indent + 1, unit)}${line},`).join('\n')}\n${pad(indent, unit)}${close}`;
}

const identifier = (key: string) => /^[A-Za-z_$][\w$]*$/.test(key);

const node: Syntax = {
  document: (entries, indent) =>
    block(
      '{',
      '}',
      entries.map(([key, value]) => `${identifier(key) ? key : JSON.stringify(key)}: ${value}`),
      indent,
    ),
  array: (items, indent) => block('[', ']', items, indent),
  scalar(value, uses) {
    const use = (name: string, text: string) => (uses.add(name), text);
    switch (value.type) {
      case 'String':
        return JSON.stringify(value.text);
      case 'Int32':
        return value.text;
      case 'Int64':
        return use('Long', `Long.fromString(${JSON.stringify(value.text)})`);
      case 'Double':
        return value.text.endsWith('.0') ? use('Double', `new Double(${value.text})`) : value.text;
      case 'Decimal128':
        return use('Decimal128', `Decimal128.fromString(${JSON.stringify(value.text)})`);
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'null';
      case 'Date':
        return `new Date(${JSON.stringify(value.iso)})`;
      case 'ObjectId':
        return use('ObjectId', `new ObjectId(${JSON.stringify(value.hex)})`);
      case 'Binary':
        return use(
          'Binary',
          `new Binary(Buffer.from(${JSON.stringify(value.base64)}, 'base64'), ${value.subtype})`,
        );
      case 'UUID':
        return use('UUID', `new UUID(${JSON.stringify(value.uuid)})`);
      case 'RegExp':
        return use(
          'BSONRegExp',
          `new BSONRegExp(${JSON.stringify(value.pattern)}, ${JSON.stringify(value.options)})`,
        );
      case 'Timestamp':
        return use('Timestamp', `new Timestamp({ t: ${value.t}, i: ${value.i} })`);
      case 'MinKey':
        return use('MinKey', 'new MinKey()');
      case 'MaxKey':
        return use('MaxKey', 'new MaxKey()');
      case 'Code':
        return use('Code', `new Code(${JSON.stringify(value.text)})`);
      case 'Symbol':
        return use('BSONSymbol', `new BSONSymbol(${JSON.stringify(value.text)})`);
    }
  },
};

const python: Syntax = {
  document: (entries, indent) =>
    block(
      '{',
      '}',
      entries.map(([key, value]) => `${JSON.stringify(key)}: ${value}`),
      indent,
      '    ',
    ),
  array: (items, indent) => block('[', ']', items, indent, '    '),
  scalar(value, uses) {
    const use = (name: string, text: string) => (uses.add(name), text);
    switch (value.type) {
      case 'String':
      case 'Symbol':
        return JSON.stringify(value.text);
      case 'Int32':
      case 'Double':
        return value.text;
      case 'Int64':
        return use('Int64', `Int64(${value.text})`);
      case 'Decimal128':
        return use('Decimal128', `Decimal128(${JSON.stringify(value.text)})`);
      case 'Boolean':
        return value.value ? 'True' : 'False';
      case 'Null':
        return 'None';
      case 'Date':
        return use(
          'datetime',
          `datetime.fromisoformat(${JSON.stringify(value.iso.replace('Z', '+00:00'))})`,
        );
      case 'ObjectId':
        return use('ObjectId', `ObjectId(${JSON.stringify(value.hex)})`);
      case 'Binary':
        return use(
          'Binary',
          `Binary(base64.b64decode(${JSON.stringify(value.base64)}), ${value.subtype})`,
        );
      case 'UUID':
        return use('UUID', `UUID(${JSON.stringify(value.uuid)})`);
      case 'RegExp':
        return use(
          'Regex',
          `Regex(${JSON.stringify(value.pattern)}, ${JSON.stringify(value.options)})`,
        );
      case 'Timestamp':
        return use('Timestamp', `Timestamp(${value.t}, ${value.i})`);
      case 'MinKey':
        return use('MinKey', 'MinKey()');
      case 'MaxKey':
        return use('MaxKey', 'MaxKey()');
      case 'Code':
        return use('Code', `Code(${JSON.stringify(value.text)})`);
    }
  },
};

const php: Syntax = {
  document: (entries, indent, nested) =>
    !entries.length && nested
      ? 'new \\stdClass()'
      : block(
          '[',
          ']',
          entries.map(([key, value]) => `${quote('php', key)} => ${value}`),
          indent,
          '    ',
        ),
  array: (items, indent) => block('[', ']', items, indent, '    '),
  scalar(value, uses) {
    const use = (name: string, text: string) => (uses.add(name), text);
    const q = (text: string) => quote('php', text);
    switch (value.type) {
      case 'String':
      case 'Symbol':
        return q(value.text);
      case 'Int32':
      case 'Double':
        return value.text;
      case 'Int64':
        return use('Int64', `new Int64(${q(value.text)})`);
      case 'Decimal128':
        return use('Decimal128', `new Decimal128(${q(value.text)})`);
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'null';
      case 'Date':
        return use('UTCDateTime', `new UTCDateTime(${value.millis})`);
      case 'ObjectId':
        return use('ObjectId', `new ObjectId(${q(value.hex)})`);
      case 'Binary':
        return use('Binary', `new Binary(base64_decode(${q(value.base64)}), ${value.subtype})`);
      case 'UUID':
        return use(
          'Binary',
          `new Binary(hex2bin(${q(value.uuid.replace(/-/g, ''))}), Binary::TYPE_UUID)`,
        );
      case 'RegExp':
        return use('Regex', `new Regex(${q(value.pattern)}, ${q(value.options)})`);
      case 'Timestamp':
        return use('Timestamp', `new Timestamp(${value.i}, ${value.t})`);
      case 'MinKey':
        return use('MinKey', 'new MinKey()');
      case 'MaxKey':
        return use('MaxKey', 'new MaxKey()');
      case 'Code':
        return use('Javascript', `new Javascript(${q(value.text)})`);
    }
  },
};

const RUBY_SUBTYPES = [
  'generic',
  'function',
  'old',
  'uuid_old',
  'uuid',
  'md5',
  'ciphertext',
  'column',
  'sensitive',
];
const ruby: Syntax = {
  document: (entries, indent) =>
    block(
      '{',
      '}',
      entries.map(([key, value]) => `${quote('ruby', key)} => ${value}`),
      indent,
    ),
  array: (items, indent) => block('[', ']', items, indent),
  scalar(value, uses) {
    const q = (text: string) => quote('ruby', text);
    switch (value.type) {
      case 'String':
        return q(value.text);
      case 'Symbol':
        return `BSON::Symbol::Raw.new(${q(value.text)})`;
      case 'Int32':
      case 'Double':
        return value.text;
      case 'Int64':
        return `BSON::Int64.new(${value.text})`;
      case 'Decimal128':
        return `BSON::Decimal128.new(${q(value.text)})`;
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'nil';
      case 'Date':
        return `Time.at(Rational(${value.millis}, 1000)).utc`;
      case 'ObjectId':
        return `BSON::ObjectId.from_string(${q(value.hex)})`;
      case 'Binary':
        uses.add('base64');
        return `BSON::Binary.new(Base64.decode64(${q(value.base64)}), :${RUBY_SUBTYPES[value.subtype] ?? 'user'})`;
      case 'UUID':
        return `BSON::Binary.from_uuid(${q(value.uuid)})`;
      case 'RegExp':
        return `BSON::Regexp::Raw.new(${q(value.pattern)}, ${q(value.options)})`;
      case 'Timestamp':
        return `BSON::Timestamp.new(${value.t}, ${value.i})`;
      case 'MinKey':
        return 'BSON::MinKey.new';
      case 'MaxKey':
        return 'BSON::MaxKey.new';
      case 'Code':
        return `BSON::Code.new(${q(value.text)})`;
    }
  },
};

/** The mongosh writer: the shell syntax of the explorer. */
const mongosh = (): ValueWriter => ({
  uses: new Set(),
  value: (value, indent) => shellText(value, indent),
});

export const DYNAMIC_WRITERS: Partial<Record<CodeLanguage, () => ValueWriter>> = {
  mongosh,
  node: () => writer(node),
  python: () => writer(python),
  php: () => writer(php),
  ruby: () => writer(ruby),
};

export { block, writer, type Syntax };
