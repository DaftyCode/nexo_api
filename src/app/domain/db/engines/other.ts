/**
 * The engines that are not the relational servers of the first modules: Cassandra, Redis,
 * Elasticsearch, Drill, MongoDB, Hive, Ignite and the files module, as the connection form
 * knows them.
 */
import { TLS_MODES } from '../connection';
import type { EngineProfile } from '../engines';

export const OTHER_ENGINES: Record<string, EngineProfile> = {
  // Cassandra and ScyllaDB (DB-34): the host takes several contact points, separated by
  // commas; the database is the keyspace the session starts in.
  cassandra: {
    id: 'cassandra',
    name: 'Cassandra',
    summary: 'db.engine.cassandra',
    defaultPort: 9042,
    defaultHost: 'localhost',
    defaultDatabase: '',
    defaultUser: '',
    schemes: ['cassandra', 'scylla'],
    tlsModes: TLS_MODES,
    properties: [
      { name: 'localDc', description: 'db.property.localDc' },
      { name: 'consistency', description: 'db.property.consistency' },
      { name: 'pageSize', description: 'db.property.pageSize' },
    ],
    limits: 'db.limits.cassandra',
  },
  // Redis and Valkey (DB-35): one server, the master of Sentinels or a cluster; the database
  // is a number (0 to 15 by default).
  redis: {
    id: 'redis',
    name: 'Redis',
    summary: 'db.engine.redis',
    badge: 'popular',
    keyValue: true,
    defaultPort: 6379,
    defaultHost: 'localhost',
    defaultDatabase: '0',
    defaultUser: '',
    schemes: ['redis', 'rediss', 'valkey'],
    tlsModes: TLS_MODES,
    properties: [
      { name: 'mode', description: 'db.property.mode' },
      { name: 'master', description: 'db.property.master' },
    ],
    limits: 'db.limits.redis',
  },
  // Elasticsearch and OpenSearch (DB-36): their nodes, separated by commas; SQL through the
  // engine's SQL API, and a console of Query DSL.
  elastic: {
    id: 'elastic',
    name: 'Elasticsearch',
    summary: 'db.engine.elastic',
    rest: true,
    defaultPort: 9200,
    defaultHost: 'localhost',
    defaultDatabase: '',
    defaultUser: 'elastic',
    schemes: ['elasticsearch', 'opensearch'],
    tlsModes: TLS_MODES,
    properties: [{ name: 'auth', description: 'db.property.auth' }],
    limits: 'db.limits.elastic',
  },
  // Apache Drill (DB-37): its REST API, on port 8047; the database is the default schema.
  drill: {
    id: 'drill',
    name: 'Apache Drill',
    summary: 'db.engine.drill',
    defaultPort: 8047,
    defaultHost: 'localhost',
    defaultDatabase: '',
    defaultUser: '',
    schemes: ['drill'],
    tlsModes: TLS_MODES,
    properties: [],
    limits: 'db.limits.drill',
  },
  // MongoDB (DB-39): a connection string with its own form; its collections open in the
  // explorer of documents. Its URLs are read by that form, not by the SQL one.
  mongodb: {
    id: 'mongodb',
    name: 'MongoDB',
    summary: 'db.engine.mongodb',
    badge: 'popular',
    documents: true,
    defaultPort: 27017,
    defaultHost: 'localhost',
    defaultDatabase: '',
    defaultUser: '',
    schemes: [],
    tlsModes: [],
    properties: [],
  },
  // Apache Hive (DB-42): HiveServer2 in HTTP mode, with a user and a password; its JDBC URLs
  // carry their settings after `;` in the path.
  hive: {
    id: 'hive',
    name: 'Apache Hive',
    summary: 'db.engine.hive',
    defaultPort: 10001,
    defaultHost: 'localhost',
    defaultDatabase: 'default',
    defaultUser: 'hive',
    schemes: ['hive2', 'hive'],
    tlsParameter: 'ssl',
    tlsValues: {
      disable: 'false',
      prefer: 'true',
      require: 'true',
      verify: 'true',
    },
    tlsModes: TLS_MODES,
    pathSettings: true,
    properties: [{ name: 'httpPath', description: 'db.property.httpPath' }],
    limits: 'db.limits.hive',
  },
  // Apache Ignite 3 (DB-43): its client protocol on port 10800; the database is the default
  // schema. Its JDBC URLs (`jdbc:ignite:thin://host:10800/SHOP?sslEnabled=true`) are read too.
  ignite: {
    id: 'ignite',
    name: 'Apache Ignite',
    summary: 'db.engine.ignite',
    defaultPort: 10800,
    defaultHost: 'localhost',
    defaultDatabase: 'PUBLIC',
    defaultUser: '',
    schemes: ['ignite'],
    tlsParameter: 'sslEnabled',
    tlsValues: {
      disable: 'false',
      prefer: 'true',
      require: 'true',
      verify: 'true',
    },
    tlsModes: TLS_MODES,
    properties: [{ name: 'timeZone', description: 'db.property.timeZone' }],
    limits: 'db.limits.ignite',
  },
  // Files as tables and DuckDB databases (DB-30): a folder, files or a `.duckdb` file.
  files: {
    id: 'files',
    name: 'Files and DuckDB',
    summary: 'db.engine.files',
    file: true,
    folder: true,
    fileLabel: 'Folder, files or DuckDB database',
    fileHelp: 'db.files.help',
    filePlaceholder: 'db.files.placeholder',
    defaultHost: '',
    defaultDatabase: '',
    defaultUser: '',
    schemes: ['duckdb'],
    tlsModes: [],
    properties: [
      { name: 'delimiter', description: 'db.property.delimiter' },
      { name: 'header', description: 'db.property.header' },
      { name: 'quote', description: 'db.property.quote' },
      { name: 'encoding', description: 'db.property.encoding' },
      { name: 'sheet', description: 'db.property.sheet' },
      { name: 'json_format', description: 'db.property.json_format' },
      { name: 'all_varchar', description: 'db.property.all_varchar' },
    ],
    limits: 'db.limits.files',
  },
};
