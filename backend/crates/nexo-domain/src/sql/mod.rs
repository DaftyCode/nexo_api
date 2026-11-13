//! SQL as Nexo reads it, without running anything: scripts split into statements, what
//! each statement does, and the rules of a saved SQL connection.
mod classify;
mod connection;
mod scanner;
mod split;
#[cfg(test)]
mod tests;
mod vocabulary;

pub use classify::{Classification, StatementKind, classify};
pub use connection::{ConnectionType, validate_connection};
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
            _ => Self::Ansi,
        }
    }
}
