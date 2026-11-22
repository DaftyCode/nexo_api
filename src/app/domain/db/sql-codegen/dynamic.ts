/**
 * Programs in Node.js, Python, PHP and Ruby that run a statement with the usual library of
 * each engine, read the connection from `DATABASE_URL` and print the rows it reads or how
 * many it changed. Parameters go bound with the library's markers.
 */
import { CodeInput, SqlCodegenError, bound, lines } from './common';
import { StringLanguage, literal, valueLiteral } from './strings';

const list = (language: StringLanguage, values: readonly unknown[], open = '[', close = ']') =>
  `${open}${values.map((value) => valueLiteral(language, value as never)).join(', ')}${close}`;
const unsupported = (language: string, engine: string) =>
  new SqlCodegenError('db.code.noLibrary', { v0: language, v1: engine });

export function nodeProgram(input: CodeInput): string {
  const env = 'process.env.DATABASE_URL';
  switch (input.family) {
    case 'postgres': {
      const { sql, values } = bound(input, 'dollar');
      return lines(
        '// npm install pg',
        "import pg from 'pg';",
        '',
        `const client = new pg.Client({ connectionString: ${env} });`,
        'await client.connect();',
        `const sql = ${literal('node', sql)};`,
        `const result = await client.query(sql, ${list('node', values)});`,
        'console.log(result.rows.length ? result.rows : result.rowCount);',
        'await client.end();',
      );
    }
    case 'mysql': {
      const { sql, values } = bound(input, 'question');
      return lines(
        '// npm install mysql2',
        "import mysql from 'mysql2/promise';",
        '',
        `const connection = await mysql.createConnection(${env});`,
        `const sql = ${literal('node', sql)};`,
        `const [rows] = await connection.execute(sql, ${list('node', values)});`,
        'console.log(rows);',
        'await connection.end();',
      );
    }
    case 'sqlite': {
      const { sql, values } = bound(input, 'question');
      return lines(
        '// npm install better-sqlite3',
        "import Database from 'better-sqlite3';",
        '',
        '// DATABASE_URL is the path of the file.',
        `const db = new Database(${env});`,
        `const statement = db.prepare(${literal('node', sql)});`,
        `const values = ${list('node', values)};`,
        'console.log(statement.reader ? statement.all(...values) : statement.run(...values));',
        'db.close();',
      );
    }
    case 'mssql': {
      const { sql, values } = bound(input, 'at');
      return lines(
        '// npm install mssql',
        "import sql from 'mssql';",
        '',
        `const pool = await sql.connect(${env});`,
        'const request = pool.request();',
        ...values.map(
          (value, at) => `request.input('p${at + 1}', ${valueLiteral('node', value)});`,
        ),
        `const result = await request.query(${literal('node', sql)});`,
        'console.log(result.recordset ?? result.rowsAffected);',
        'await pool.close();',
      );
    }
    case 'duckdb': {
      const { sql, values } = bound(input, 'dollar');
      return lines(
        '// npm install @duckdb/node-api',
        "import { DuckDBInstance } from '@duckdb/node-api';",
        '',
        `const instance = await DuckDBInstance.create(${env});`,
        'const connection = await instance.connect();',
        `const reader = await connection.runAndReadAll(${literal('node', sql)}, ${list('node', values)});`,
        'console.log(reader.getRowObjects());',
      );
    }
  }
}

export function pythonProgram(input: CodeInput): string {
  const run = (
    setup: string[],
    connect: string,
    marker: 'percent' | 'question' | 'dollar',
    before: string[] = [],
  ) => {
    const { sql, values } = bound(input, marker);
    return lines(
      ...setup,
      'import os',
      '',
      ...before,
      `connection = ${connect}`,
      'cursor = connection.cursor()',
      values.length
        ? `cursor.execute(${literal('python', sql)}, ${list('python', values)})`
        : `cursor.execute(${literal('python', sql)})`,
      'print(cursor.fetchall() if cursor.description else cursor.rowcount)',
      'connection.commit()',
      'connection.close()',
    );
  };
  const env = 'os.environ["DATABASE_URL"]';
  switch (input.family) {
    case 'postgres':
      return run(
        ['# pip install "psycopg[binary]"', 'import psycopg'],
        `psycopg.connect(${env})`,
        'percent',
      );
    case 'mysql':
      return run(
        [
          '# pip install mysql-connector-python',
          'import mysql.connector',
          'from urllib.parse import urlparse',
        ],
        'mysql.connector.connect(\n    host=url.hostname,\n    port=url.port or 3306,\n    user=url.username,\n    password=url.password,\n    database=url.path.lstrip("/"),\n)',
        'percent',
        [`url = urlparse(${env})`],
      );
    case 'sqlite':
      return run(
        ['# DATABASE_URL is the path of the file.', 'import sqlite3'],
        `sqlite3.connect(${env})`,
        'question',
      );
    case 'mssql':
      return run(
        ['# pip install pyodbc  (DATABASE_URL is an ODBC connection string)', 'import pyodbc'],
        `pyodbc.connect(${env})`,
        'question',
      );
    case 'duckdb':
      return run(['# pip install duckdb', 'import duckdb'], `duckdb.connect(${env})`, 'dollar');
  }
}

export function phpProgram(input: CodeInput): string {
  if (input.family === 'duckdb') throw unsupported('PHP', 'DuckDB');
  const { sql, values } = bound(input, 'question');
  return lines(
    '<?php',
    '// PDO with the driver of the engine; DATABASE_URL is its DSN (pgsql:host=…;dbname=…).',
    "$pdo = new PDO(getenv('DATABASE_URL'), getenv('DATABASE_USER') ?: null, getenv('DATABASE_PASSWORD') ?: null, [",
    '    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,',
    ']);',
    `$statement = $pdo->prepare(${literal('php', sql)});`,
    `$statement->execute(${list('php', values)});`,
    'print_r($statement->columnCount() ? $statement->fetchAll(PDO::FETCH_ASSOC) : $statement->rowCount());',
  );
}

export function rubyProgram(input: CodeInput): string {
  const env = "ENV.fetch('DATABASE_URL')";
  switch (input.family) {
    case 'postgres': {
      const { sql, values } = bound(input, 'dollar');
      return lines(
        '# gem install pg',
        "require 'pg'",
        '',
        `connection = PG.connect(${env})`,
        `result = connection.exec_params(${literal('ruby', sql)}, ${list('ruby', values)})`,
        'puts(result.ntuples.positive? ? result.to_a : result.cmd_tuples)',
        'connection.close',
      );
    }
    case 'mysql': {
      const { sql, values } = bound(input, 'question');
      return lines(
        '# gem install mysql2',
        "require 'mysql2'",
        "require 'uri'",
        '',
        `url = URI(${env})`,
        'client = Mysql2::Client.new(host: url.host, port: url.port || 3306, username: url.user,',
        "                            password: url.password, database: url.path.delete_prefix('/'))",
        `statement = client.prepare(${literal('ruby', sql)})`,
        `result = statement.execute(*${list('ruby', values)})`,
        'puts(result ? result.to_a : client.affected_rows)',
        'client.close',
      );
    }
    case 'sqlite': {
      const { sql, values } = bound(input, 'question');
      return lines(
        '# gem install sqlite3  (DATABASE_URL is the path of the file)',
        "require 'sqlite3'",
        '',
        `db = SQLite3::Database.new(${env}, results_as_hash: true)`,
        `puts db.execute(${literal('ruby', sql)}, ${list('ruby', values)}).inspect`,
        'db.close',
      );
    }
    default:
      throw unsupported('Ruby', input.family === 'mssql' ? 'SQL Server' : 'DuckDB');
  }
}
