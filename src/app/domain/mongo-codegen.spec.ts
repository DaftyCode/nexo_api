import {
  CODE_LANGUAGES,
  CodegenError,
  CodeLanguage,
  CodeQuery,
  generateCode,
} from './mongo-codegen';
import { shellToExtendedJson } from './mongo-query';

const read = (text: string) => shellToExtendedJson(text) as Record<string, unknown>;

/** A find with every BSON type and a quote that needs escaping. */
const find: CodeQuery = {
  kind: 'find',
  database: 'shop',
  collection: 'orders',
  filter: read(`{
    _id: ObjectId("65a1b2c3d4e5f6a7b8c9d0e1"),
    at: { $gte: ISODate("2024-01-02T03:04:05.006Z") },
    big: NumberLong("9007199254740993"),
    price: NumberDecimal("19.99"),
    n: 7, ratio: 1.5, whole: 2.0,
    name: /^o'k "x"/i,
    ok: true, none: null,
    tags: { $in: ["a", "b"] },
    bin: BinData(0, "AQID"),
    id: UUID("3b241101-e2bb-4255-8caf-4136c566a962"),
    ts: Timestamp({ t: 1, i: 2 })
  }`),
  projection: { name: 1, _id: 0 },
  sort: { at: -1 },
  skip: 5,
  limit: 10,
  hint: 'at_-1',
};

const aggregate: CodeQuery = {
  kind: 'aggregate',
  database: 'shop',
  collection: 'orders',
  pipeline: [
    read("{ $match: { status: 'A' } }"),
    read("{ $group: { _id: '$city', n: { $sum: 1 } } }"),
  ],
  allowDiskUse: true,
};

const expected: Record<string, string[]> = {
  mongosh: [
    'db.getSiblingDB("shop").getCollection("orders")',
    'ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")',
    'ISODate("2024-01-02T03:04:05.006Z")',
    'NumberLong("9007199254740993")',
    '.sort(',
    '.limit(10)',
  ],
  node: [
    "import { BSONRegExp, Binary, Decimal128, Double, Long, MongoClient, ObjectId, Timestamp, UUID } from 'mongodb';",
    'process.env.MONGODB_URI',
    'new Date("2024-01-02T03:04:05.006Z")',
    'new Double(2.0)',
    'Long.fromString("9007199254740993")',
    'new UUID("3b241101-e2bb-4255-8caf-4136c566a962")',
    'limit: 10',
  ],
  python: [
    'from bson import Binary, Decimal128, Int64, ObjectId, Regex, Timestamp',
    'from uuid import UUID',
    'os.environ["MONGODB_URI"]',
    'datetime.fromisoformat("2024-01-02T03:04:05.006+00:00")',
    'Int64(9007199254740993)',
    '"ok": True',
    '"none": None',
    'sort=[("at", -1)]',
    'hint="at_-1"',
  ],
  java: [
    'import org.bson.types.ObjectId;',
    'System.getenv("MONGODB_URI")',
    '9007199254740993L',
    'Decimal128.parse("19.99")',
    'Date.from(Instant.parse("2024-01-02T03:04:05.006Z"))',
    '.hintString("at_-1")',
    '.limit(10)',
  ],
  csharp: [
    'Environment.GetEnvironmentVariable("MONGODB_URI")',
    'ObjectId.Parse("65a1b2c3d4e5f6a7b8c9d0e1")',
    'new DateTime(2024, 1, 2, 3, 4, 5, 6, DateTimeKind.Utc)',
    'Guid.Parse("3b241101-e2bb-4255-8caf-4136c566a962"), GuidRepresentation.Standard',
    'new FindOptions { Hint = "at_-1" }',
    '.Limit(10)',
  ],
  go: [
    '"go.mongodb.org/mongo-driver/v2/bson"',
    'func must[T any]',
    'must(bson.ObjectIDFromHex("65a1b2c3d4e5f6a7b8c9d0e1"))',
    'int64(9007199254740993)',
    'bson.NewDateTimeFromTime(time.UnixMilli(1704164645006).UTC())',
    'bson.Binary{Subtype: 0x04',
    'SetLimit(10)',
  ],
  rust: [
    'ObjectId::parse_str("65a1b2c3d4e5f6a7b8c9d0e1")?',
    '9007199254740993_i64',
    '7_i32',
    '2.0_f64',
    'DateTime::from_millis(1704164645006)',
    'Uuid::parse_str("3b241101-e2bb-4255-8caf-4136c566a962")?',
    '.hint(Hint::Name("at_-1".into()))',
    'options::Hint',
  ],
  php: [
    'use MongoDB\\BSON\\ObjectId;',
    "getenv('MONGODB_URI')",
    "new ObjectId('65a1b2c3d4e5f6a7b8c9d0e1')",
    'new UTCDateTime(1704164645006)',
    "new Regex('^o\\'k \"x\"', 'i')",
    'new Timestamp(2, 1)',
    "'limit' => 10",
  ],
  ruby: [
    "require 'base64'",
    "ENV.fetch('MONGODB_URI')",
    "BSON::ObjectId.from_string('65a1b2c3d4e5f6a7b8c9d0e1')",
    'Time.at(Rational(1704164645006, 1000)).utc',
    'BSON::Int64.new(9007199254740993)',
    "BSON::Regexp::Raw.new('^o\\'k \"x\"', 'i')",
    'limit: 10',
  ],
};

describe('Driver code for MongoDB queries', () => {
  it('writes every BSON type of a find in each language', () => {
    for (const { id } of CODE_LANGUAGES) {
      const code = generateCode(id, find);
      for (const part of expected[id]) expect(code, `${id}: ${part}`).toContain(part);
      // The program never carries a connection string.
      expect(code).not.toContain('mongodb://');
    }
  });

  it('writes aggregations with their options', () => {
    const parts: Record<string, string> = {
      mongosh: '.aggregate([',
      node: 'allowDiskUse: true',
      python: 'allowDiskUse=True',
      java: '.allowDiskUse(true)',
      csharp: 'new AggregateOptions { AllowDiskUse = true }',
      go: 'SetAllowDiskUse(true)',
      rust: '.allow_disk_use(true)',
      php: "'allowDiskUse' => true",
      ruby: 'allow_disk_use: true',
    };
    for (const { id } of CODE_LANGUAGES) {
      const code = generateCode(id, aggregate);
      expect(code, id).toContain(parts[id]);
      expect(code, id).toContain('$group');
    }
  });

  it('escapes strings for each language', () => {
    const query: CodeQuery = {
      kind: 'find',
      database: 'a',
      collection: 'b',
      filter: { text: 'it\'s "x"\n\u0001' },
    };
    expect(generateCode('rust', query)).toContain('"it\'s \\"x\\"\\n\\u{0001}"');
    expect(generateCode('php', query)).toContain("'it\\'s \"x\"\n\u0001'");
    expect(generateCode('node', query)).toContain('"it\'s \\"x\\"\\n\\u0001"');
  });
});

describe('Driver code for MongoDB queries, with every option', () => {
  const bare: CodeQuery = { kind: 'find', database: 'a', collection: 'b' };
  const options: CodeQuery = {
    kind: 'aggregate',
    database: 'shop',
    collection: 'orders',
    pipeline: [{ $match: { n: 1 } }],
    collation: { locale: 'es' },
    hint: { at: -1 },
    maxTimeMS: 500,
  };
  const findWithKeys: CodeQuery = { ...find, hint: { at: -1 }, collation: { locale: 'es' } };

  it('writes a bare find in each language', () => {
    for (const { id } of CODE_LANGUAGES) {
      const code = generateCode(id, bare);
      expect(code, id).toMatch(/["']b["']/);
      expect(code, id).not.toContain('limit(10)');
    }
  });

  it('writes the time limit, collation and hint of an aggregation', () => {
    const parts: Record<string, string[]> = {
      java: [
        '.maxTime(500, TimeUnit.MILLISECONDS)',
        'import java.util.concurrent.TimeUnit;',
        '// Collation',
      ],
      csharp: ['MaxTime = TimeSpan.FromMilliseconds(500)', 'Hint = ', '// Collation'],
      go: ['// maxTimeMS 500', '// Collation', 'SetHint('],
      rust: ['.max_time(std::time::Duration::from_millis(500))', 'Hint::Keys('],
    };
    for (const [language, expected] of Object.entries(parts)) {
      const code = generateCode(language as CodeLanguage, options);
      for (const part of expected) expect(code, `${language}: ${part}`).toContain(part);
    }
    for (const { id } of CODE_LANGUAGES) expect(generateCode(id, options), id).toContain('500');
  });

  it('writes a hint by its keys and the collation of a find', () => {
    expect(generateCode('java', findWithKeys)).toContain('.hint(');
    expect(generateCode('csharp', findWithKeys)).toContain('new FindOptions { Hint = ');
    expect(generateCode('go', findWithKeys)).toContain('SetHint(');
    expect(generateCode('rust', findWithKeys)).toContain('Hint::Keys(');
    for (const { id } of CODE_LANGUAGES)
      expect(generateCode(id, findWithKeys).toLowerCase(), id).toContain('collation');
  });
});

describe('Driver code for the rarer BSON values', () => {
  const rare: CodeQuery = {
    kind: 'find',
    database: 'a',
    collection: 'b',
    filter: {
      low: { $minKey: 1 },
      high: { $maxKey: 1 },
      code: { $code: 'function () {}' },
      symbol: { $symbol: 'sym' },
      empty: {},
      'odd-key': false,
      int: { $numberInt: '3' },
      long: { $numberLong: '4' },
      blob: { $binary: { base64: 'AQ==', subType: '80' } },
    },
  };

  it('writes MinKey, MaxKey, Code, Symbol, empty documents and odd keys in each language', () => {
    for (const { id } of CODE_LANGUAGES) {
      const code = generateCode(id, rare);
      expect(code, id).toMatch(/min_?key/i);
      expect(code, id).toMatch(/max_?key/i);
      expect(code, id).toContain('odd-key');
    }
    expect(generateCode('python', rare)).toContain('False');
    expect(generateCode('php', rare)).toContain(String.raw`new \stdClass()`);
  });

  it('refuses a number no language can write', () => {
    const query: CodeQuery = {
      kind: 'find',
      database: 'a',
      collection: 'b',
      filter: { n: { $numberDouble: 'NaN' } },
    };
    expect(() => generateCode('node', query)).toThrow(CodegenError);
    const unknown: CodeQuery = {
      kind: 'find',
      database: 'a',
      collection: 'b',
      filter: { p: { $dbPointer: { $ref: 'x', $id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' } } } },
    };
    expect(() => generateCode('java', unknown)).toThrow(CodegenError);
  });
});
