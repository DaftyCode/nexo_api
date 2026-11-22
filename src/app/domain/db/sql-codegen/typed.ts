/**
 * Programs in Java (JDBC), C# (ADO.NET), Go (`database/sql`) and Rust that run a statement
 * with the usual library of each engine, read the connection from `DATABASE_URL` and print
 * the rows it reads or how many it changed. Parameters go bound with the library's markers.
 */
import { CodeInput, CodeValue, bound, lines } from './common';
import { literal, valueLiteral } from './strings';

const JDBC: Record<CodeInput['family'], string> = {
  postgres: 'org.postgresql:postgresql',
  mysql: 'com.mysql:mysql-connector-j',
  sqlite: 'org.xerial:sqlite-jdbc',
  mssql: 'com.microsoft.sqlserver:mssql-jdbc',
  duckdb: 'org.duckdb:duckdb_jdbc',
};

export function javaProgram(input: CodeInput): string {
  const { sql, values } = bound(input, 'question');
  return lines(
    `// The JDBC driver ${JDBC[input.family]}; DATABASE_URL is its JDBC URL.`,
    'import java.sql.*;',
    '',
    'public class Query {',
    '  public static void main(String[] args) throws SQLException {',
    '    String sql =',
    `    ${literal('java', sql)};`,
    '    try (Connection connection = DriverManager.getConnection(System.getenv("DATABASE_URL"));',
    '        PreparedStatement statement = connection.prepareStatement(sql)) {',
    ...values.map(
      (value, at) => `      statement.setObject(${at + 1}, ${valueLiteral('java', value)});`,
    ),
    '      if (statement.execute()) {',
    '        try (ResultSet rows = statement.getResultSet()) {',
    '          int columns = rows.getMetaData().getColumnCount();',
    '          while (rows.next()) {',
    '            StringBuilder line = new StringBuilder();',
    '            for (int column = 1; column <= columns; column++) {',
    '              line.append(column > 1 ? "\\t" : "").append(rows.getObject(column));',
    '            }',
    '            System.out.println(line);',
    '          }',
    '        }',
    '      } else {',
    '        System.out.println(statement.getUpdateCount() + " rows changed");',
    '      }',
    '    }',
    '  }',
    '}',
  );
}

const ADO: Record<CodeInput['family'], { package: string; namespace: string; type: string }> = {
  postgres: { package: 'Npgsql', namespace: 'Npgsql', type: 'NpgsqlConnection' },
  mysql: { package: 'MySqlConnector', namespace: 'MySqlConnector', type: 'MySqlConnection' },
  sqlite: {
    package: 'Microsoft.Data.Sqlite',
    namespace: 'Microsoft.Data.Sqlite',
    type: 'SqliteConnection',
  },
  mssql: {
    package: 'Microsoft.Data.SqlClient',
    namespace: 'Microsoft.Data.SqlClient',
    type: 'SqlConnection',
  },
  duckdb: {
    package: 'DuckDB.NET.Data.Full',
    namespace: 'DuckDB.NET.Data',
    type: 'DuckDBConnection',
  },
};

export function csharpProgram(input: CodeInput): string {
  const library = ADO[input.family];
  // DuckDB.NET names its parameters with `$`; the others with `@`.
  const { sql, values } = bound(input, input.family === 'duckdb' ? 'dollar' : 'at');
  const name = (at: number) => (input.family === 'duckdb' ? `${at + 1}` : `@p${at + 1}`);
  return lines(
    `// dotnet add package ${library.package}; DATABASE_URL is its connection string.`,
    `using ${library.namespace};`,
    '',
    `await using var connection = new ${library.type}(Environment.GetEnvironmentVariable("DATABASE_URL"));`,
    'await connection.OpenAsync();',
    'await using var command = connection.CreateCommand();',
    `command.CommandText = ${literal('csharp', sql)};`,
    ...values.flatMap((value, at) => [
      '{',
      '    var parameter = command.CreateParameter();',
      `    parameter.ParameterName = "${name(at)}";`,
      `    parameter.Value = ${valueLiteral('csharp', value)};`,
      '    command.Parameters.Add(parameter);',
      '}',
    ]),
    'await using var reader = await command.ExecuteReaderAsync();',
    'while (await reader.ReadAsync())',
    '{',
    '    var row = new object[reader.FieldCount];',
    '    reader.GetValues(row);',
    '    Console.WriteLine(string.Join("\\t", row));',
    '}',
    'if (reader.FieldCount == 0) Console.WriteLine($"{reader.RecordsAffected} rows changed");',
  );
}

const GO: Record<
  CodeInput['family'],
  { module: string; driver: string; marker: 'dollar' | 'question' | 'at' }
> = {
  postgres: { module: 'github.com/jackc/pgx/v5/stdlib', driver: 'pgx', marker: 'dollar' },
  mysql: { module: 'github.com/go-sql-driver/mysql', driver: 'mysql', marker: 'question' },
  sqlite: { module: 'modernc.org/sqlite', driver: 'sqlite', marker: 'question' },
  mssql: { module: 'github.com/microsoft/go-mssqldb', driver: 'sqlserver', marker: 'at' },
  duckdb: { module: 'github.com/marcboeker/go-duckdb', driver: 'duckdb', marker: 'question' },
};

export function goProgram(input: CodeInput): string {
  const library = GO[input.family];
  const { sql, values } = bound(input, library.marker);
  const args = values.map((value) => `, ${valueLiteral('go', value)}`).join('');
  return lines(
    `// go get ${library.module}; DATABASE_URL is its data source name.`,
    'package main',
    '',
    'import (',
    '\t"database/sql"',
    '\t"fmt"',
    '\t"log"',
    '\t"os"',
    '',
    `\t_ "${library.module}"`,
    ')',
    '',
    'func main() {',
    `\tdb, err := sql.Open("${library.driver}", os.Getenv("DATABASE_URL"))`,
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '\tdefer db.Close()',
    `\tquery := ${literal('go', sql)}`,
    `\trows, err := db.Query(query${args})`,
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '\tdefer rows.Close()',
    '\tcolumns, _ := rows.Columns()',
    '\tfor rows.Next() {',
    '\t\tvalues := make([]any, len(columns))',
    '\t\tpointers := make([]any, len(columns))',
    '\t\tfor i := range values {',
    '\t\t\tpointers[i] = &values[i]',
    '\t\t}',
    '\t\tif err := rows.Scan(pointers...); err != nil {',
    '\t\t\tlog.Fatal(err)',
    '\t\t}',
    '\t\tfmt.Println(values...)',
    '\t}',
    '\tif err := rows.Err(); err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '}',
  );
}

/** A value bound by a Rust library: integers as `i64`, change them to the column's type. */
const rust = (value: CodeValue) =>
  typeof value === 'number' && Number.isInteger(value)
    ? `${value}i64`
    : valueLiteral('rust', value);

export function rustProgram(input: CodeInput): string {
  const refs = (values: CodeValue[]) => values.map((value) => `&${rust(value)}`).join(', ');
  switch (input.family) {
    case 'postgres': {
      const { sql, values } = bound(input, 'dollar');
      return lines(
        '// cargo add tokio --features full; cargo add tokio-postgres',
        'use tokio_postgres::NoTls;',
        '',
        '#[tokio::main]',
        'async fn main() -> Result<(), tokio_postgres::Error> {',
        '    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");',
        '    let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;',
        '    tokio::spawn(connection);',
        `    let rows = client.query(${literal('rust', sql)}, &[${refs(values)}]).await?;`,
        '    for row in rows {',
        '        println!("{row:?}");',
        '    }',
        '    Ok(())',
        '}',
      );
    }
    case 'mysql': {
      const { sql, values } = bound(input, 'question');
      return lines(
        '// cargo add tokio --features full; cargo add mysql_async',
        'use mysql_async::prelude::*;',
        '',
        '#[tokio::main]',
        'async fn main() -> Result<(), mysql_async::Error> {',
        '    let pool = mysql_async::Pool::new(std::env::var("DATABASE_URL").expect("DATABASE_URL").as_str());',
        '    let mut connection = pool.get_conn().await?;',
        `    let rows: Vec<mysql_async::Row> = connection.exec(${literal('rust', sql)}, (${values.map(rust).join(', ')}${values.length === 1 ? ',' : ''})).await?;`,
        '    for row in rows {',
        '        println!("{row:?}");',
        '    }',
        '    drop(connection);',
        '    pool.disconnect().await',
        '}',
      );
    }
    case 'sqlite':
    case 'duckdb': {
      const crate = input.family === 'sqlite' ? 'rusqlite' : 'duckdb';
      const { sql, values } = bound(input, 'question');
      return lines(
        `// cargo add ${crate}; DATABASE_URL is the path of the file.`,
        `use ${crate}::{Connection, params};`,
        '',
        `fn main() -> ${crate}::Result<()> {`,
        '    let connection = Connection::open(std::env::var("DATABASE_URL").expect("DATABASE_URL"))?;',
        `    let mut statement = connection.prepare(${literal('rust', sql)})?;`,
        `    let mut rows = statement.query(params![${values.map(rust).join(', ')}])?;`,
        '    while let Some(row) = rows.next()? {',
        '        println!("{row:?}");',
        '    }',
        '    Ok(())',
        '}',
      );
    }
    case 'mssql': {
      const { sql, values } = bound(input, 'atUpper');
      return lines(
        '// cargo add tokio --features full; cargo add tokio-util --features compat; cargo add tiberius',
        '// DATABASE_URL is an ADO.NET connection string.',
        'use tiberius::{Client, Config};',
        'use tokio::net::TcpStream;',
        'use tokio_util::compat::TokioAsyncWriteCompatExt;',
        '',
        '#[tokio::main]',
        'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
        '    let config = Config::from_ado_string(&std::env::var("DATABASE_URL")?)?;',
        '    let tcp = TcpStream::connect(config.get_addr()).await?;',
        '    tcp.set_nodelay(true)?;',
        '    let mut client = Client::connect(config, tcp.compat_write()).await?;',
        `    let stream = client.query(${literal('rust', sql)}, &[${refs(values)}]).await?;`,
        '    for row in stream.into_first_result().await? {',
        '        println!("{row:?}");',
        '    }',
        '    Ok(())',
        '}',
      );
    }
  }
}
