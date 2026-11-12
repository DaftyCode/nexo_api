/**
 * The value writers of the typed languages: Java and C# build documents with their driver's
 * classes, Go with `bson.D`, and Rust with the `doc!` macro.
 */
import { Syntax, block, writer } from './writers';
import { CodeLanguage, ValueWriter, pad, quote } from './values';

/** The UTC parts of a date, for constructors that take them one by one. */
function utc(millis: number) {
  const date = new Date(millis);
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ];
}

const java: Syntax = {
  document(entries, indent) {
    if (!entries.length) return 'new Document()';
    const [[key, value], ...rest] = entries;
    const more = rest.map(
      ([k, v]) => `\n${pad(indent + 1, '    ')}.append(${JSON.stringify(k)}, ${v})`,
    );
    return `new Document(${JSON.stringify(key)}, ${value})${more.join('')}`;
  },
  array: (items) => `Arrays.asList(${items.join(', ')})`,
  scalar(value, uses) {
    const use = (name: string, text: string) => (uses.add(name), text);
    const q = JSON.stringify;
    switch (value.type) {
      case 'String':
        return q(value.text);
      case 'Int32':
      case 'Double':
        return value.text;
      case 'Int64':
        return `${value.text}L`;
      case 'Decimal128':
        return use('org.bson.types.Decimal128', `Decimal128.parse(${q(value.text)})`);
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'null';
      case 'Date':
        return use(
          'java.time.Instant',
          use('java.util.Date', `Date.from(Instant.parse(${q(value.iso)}))`),
        );
      case 'ObjectId':
        return use('org.bson.types.ObjectId', `new ObjectId(${q(value.hex)})`);
      case 'Binary':
        return use(
          'java.util.Base64',
          use(
            'org.bson.types.Binary',
            `new Binary((byte) ${value.subtype}, Base64.getDecoder().decode(${q(value.base64)}))`,
          ),
        );
      case 'UUID':
        return use(
          'java.util.UUID',
          use('org.bson.BsonBinary', `new BsonBinary(UUID.fromString(${q(value.uuid)}))`),
        );
      case 'RegExp':
        return use(
          'org.bson.BsonRegularExpression',
          `new BsonRegularExpression(${q(value.pattern)}, ${q(value.options)})`,
        );
      case 'Timestamp':
        return use('org.bson.BsonTimestamp', `new BsonTimestamp(${value.t}, ${value.i})`);
      case 'MinKey':
        return use('org.bson.types.MinKey', 'new MinKey()');
      case 'MaxKey':
        return use('org.bson.types.MaxKey', 'new MaxKey()');
      case 'Code':
        return use('org.bson.types.Code', `new Code(${q(value.text)})`);
      case 'Symbol':
        return use('org.bson.types.Symbol', `new Symbol(${q(value.text)})`);
    }
  },
};

const csharp: Syntax = {
  document: (entries, indent) =>
    entries.length
      ? `new BsonDocument\n${pad(indent, '    ')}${block(
          '{',
          '}',
          entries.map(([k, v]) => `{ ${JSON.stringify(k)}, ${v} }`),
          indent,
          '    ',
        )}`
      : 'new BsonDocument()',
  array: (items) => `new BsonArray { ${items.join(', ')} }`,
  scalar(value) {
    const q = JSON.stringify;
    switch (value.type) {
      case 'String':
        return q(value.text);
      case 'Int32':
      case 'Double':
        return value.text;
      case 'Int64':
        return `${value.text}L`;
      case 'Decimal128':
        return `Decimal128.Parse(${q(value.text)})`;
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'BsonNull.Value';
      case 'Date':
        return `new DateTime(${utc(value.millis).join(', ')}, DateTimeKind.Utc)`;
      case 'ObjectId':
        return `ObjectId.Parse(${q(value.hex)})`;
      case 'Binary':
        return `new BsonBinaryData(Convert.FromBase64String(${q(value.base64)}), (BsonBinarySubType)${value.subtype})`;
      case 'UUID':
        return `new BsonBinaryData(Guid.Parse(${q(value.uuid)}), GuidRepresentation.Standard)`;
      case 'RegExp':
        return `new BsonRegularExpression(${q(value.pattern)}, ${q(value.options)})`;
      case 'Timestamp':
        return `new BsonTimestamp(${value.t}, ${value.i})`;
      case 'MinKey':
        return 'BsonMinKey.Value';
      case 'MaxKey':
        return 'BsonMaxKey.Value';
      case 'Code':
        return `new BsonJavaScript(${q(value.text)})`;
      case 'Symbol':
        return `BsonSymbolTable.Lookup(${q(value.text)})`;
    }
  },
};

const go: Syntax = {
  document: (entries, indent) =>
    block(
      'bson.D{',
      '}',
      entries.map(([k, v]) => `{Key: ${JSON.stringify(k)}, Value: ${v}}`),
      indent,
      '\t',
    ),
  array: (items, indent) => block('bson.A{', '}', items, indent, '\t'),
  scalar(value, uses) {
    const use = (name: string, text: string) => (uses.add(name), text);
    const q = JSON.stringify;
    switch (value.type) {
      case 'String':
        return q(value.text);
      case 'Int32':
        return `int32(${value.text})`;
      case 'Int64':
        return `int64(${value.text})`;
      case 'Double':
        return value.text;
      case 'Decimal128':
        return use('must', `must(bson.ParseDecimal128(${q(value.text)}))`);
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'nil';
      case 'Date':
        return use('time', `bson.NewDateTimeFromTime(time.UnixMilli(${value.millis}).UTC())`);
      case 'ObjectId':
        return use('must', `must(bson.ObjectIDFromHex(${q(value.hex)}))`);
      case 'Binary':
      case 'UUID': {
        const subtype = value.type === 'UUID' ? 4 : value.subtype;
        uses.add('encoding/base64');
        return use(
          'must',
          `bson.Binary{Subtype: 0x${subtype.toString(16).padStart(2, '0')}, Data: must(base64.StdEncoding.DecodeString(${q(value.base64)}))}`,
        );
      }
      case 'RegExp':
        return `bson.Regex{Pattern: ${q(value.pattern)}, Options: ${q(value.options)}}`;
      case 'Timestamp':
        return `bson.Timestamp{T: ${value.t}, I: ${value.i}}`;
      case 'MinKey':
        return 'bson.MinKey{}';
      case 'MaxKey':
        return 'bson.MaxKey{}';
      case 'Code':
        return `bson.JavaScript(${q(value.text)})`;
      case 'Symbol':
        return `bson.Symbol(${q(value.text)})`;
    }
  },
};

const rust: Syntax = {
  document: (entries, indent, nested) =>
    `${nested ? '' : 'doc! '}${block(
      '{',
      '}',
      entries.map(([k, v]) => `${quote('rust', k)}: ${v}`),
      indent,
      '    ',
    )}`,
  array: (items, indent) => block('[', ']', items, indent, '    '),
  scalar(value, uses) {
    const use = (name: string, text: string) => (uses.add(name), text);
    const q = (text: string) => quote('rust', text);
    switch (value.type) {
      case 'String':
        return q(value.text);
      case 'Int32':
        return `${value.text}_i32`;
      case 'Int64':
        return `${value.text}_i64`;
      case 'Double':
        return `${value.text}_f64`;
      case 'Decimal128':
        return use('Decimal128', `${q(value.text)}.parse::<Decimal128>()?`);
      case 'Boolean':
        return String(value.value);
      case 'Null':
        return 'null';
      case 'Date':
        return use('DateTime', `DateTime::from_millis(${value.millis})`);
      case 'ObjectId':
        return use('oid::ObjectId', `ObjectId::parse_str(${q(value.hex)})?`);
      case 'Binary':
        return use(
          'Binary',
          use(
            'spec::BinarySubtype',
            `Binary::from_base64(${q(value.base64)}, BinarySubtype::from(${value.subtype}_u8))?`,
          ),
        );
      case 'UUID':
        return use('Uuid', `Uuid::parse_str(${q(value.uuid)})?`);
      case 'RegExp':
        return use(
          'Regex',
          use(
            'raw::CString',
            `Regex { pattern: CString::try_from(${q(value.pattern)})?, options: CString::try_from(${q(value.options)})? }`,
          ),
        );
      case 'Timestamp':
        return use('Timestamp', `Timestamp { time: ${value.t}, increment: ${value.i} }`);
      case 'MinKey':
        return use('Bson', 'Bson::MinKey');
      case 'MaxKey':
        return use('Bson', 'Bson::MaxKey');
      case 'Code':
        return use('Bson', `Bson::JavaScriptCode(${q(value.text)}.into())`);
      case 'Symbol':
        return use('Bson', `Bson::Symbol(${q(value.text)}.into())`);
    }
  },
};

export const TYPED_WRITERS: Partial<Record<CodeLanguage, () => ValueWriter>> = {
  java: () => writer(java),
  csharp: () => writer(csharp),
  go: () => writer(go),
  rust: () => writer(rust),
};
