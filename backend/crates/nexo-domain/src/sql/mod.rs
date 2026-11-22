//! SQL as Nexo reads it, without running anything: scripts split into statements, what
//! each statement does, and the rules of a saved SQL connection.
mod classify;
pub mod compare;
mod connection;
mod connection_type;
mod convert;
mod pgpass;
mod scanner;
mod session;
mod split;
#[cfg(test)]
mod tests;
mod vocabulary;

pub use classify::{Classification, StatementKind, classify};
pub use connection::{ConnectionType, validate_connection};
pub use connection_type::{TypeOf, TypeRules};
pub use convert::{Converted, SourceColumn, convert, create_table, quote};
pub use pgpass::pgpass_password;
pub use session::{SessionSettings, keep_alive_query, schema_statement};
pub use split::{Statement, split, statement_at};

/// The SQL dialect of a script: how it quotes, comments and ends statements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dialect {
    #[default]
    Ansi,
    PostgreSql,
    MySql,
    TSql,
    PlSql,
    Sqlite,
    /// CQL of Cassandra and ScyllaDB (DB-34).
    Cql,
}
impl Dialect {
    /// The dialect a driver names (`postgresql`, `mysql`, `tsql`…), or of a module id; any
    /// other name is ANSI SQL.
    pub fn parse(name: &str) -> Self {
        match name.to_ascii_lowercase().as_str() {
            "postgresql" | "postgres" | "cockroachdb" | "redshift" => Self::PostgreSql,
            "mysql" | "mariadb" => Self::MySql,
            "tsql" | "mssql" | "sqlserver" => Self::TSql,
            "plsql" | "oracle" => Self::PlSql,
            "sqlite" => Self::Sqlite,
            "cql" | "cassandra" | "scylla" => Self::Cql,
            _ => Self::Ansi,
        }
    }
}
