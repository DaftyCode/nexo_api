//! What the driver does around a statement: the commands it never sends, what the server
//! says of itself, and the plan of a statement.
use crate::session::Session;
use nexo_driver_sdk::{
    DriverError, Result,
    explain::{ExplainMode, Plan, PlanNode},
    protocol::{ConnectParams, ServerInfo},
};

/// Commands that read files of the server, change its classpath or run programs there:
/// HiveServer2 runs them for anyone who can connect, so Nexo never sends them.
pub(crate) fn refuse_server_commands(sql: &str) -> Result<()> {
    let words: Vec<String> = sql
        .split_whitespace()
        .take(2)
        .map(str::to_ascii_uppercase)
        .collect();
    let refused = match words.as_slice() {
        [first, ..] if first.starts_with('!') => true,
        [first, ..] if first == "DFS" || first == "RELOAD" || first == "COMPILE" => true,
        [first, second, ..] if first == "ADD" || first == "DELETE" || first == "LIST" => {
            ["JAR", "JARS", "FILE", "FILES", "ARCHIVE", "ARCHIVES"].contains(&second.as_str())
        }
        _ => false,
    };
    if refused {
        return Err(DriverError::invalid(
            "Nexo does not send commands that read files of the server or run programs there (ADD JAR, DFS, !…)",
        ));
    }
    Ok(())
}

/// What the server says of itself: its version, by `SELECT version()`.
pub(crate) async fn server(session: &Session, params: &ConnectParams) -> Result<ServerInfo> {
    let operation = session.start("SELECT version()").await?;
    let (_, rows) = session.read_all(operation, 1).await?;
    let version = match rows.first().and_then(|row| row.first()) {
        Some(nexo_driver_sdk::Value::Text(text)) => text
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    };
    Ok(ServerInfo {
        server_version: version,
        product: Some("Apache Hive".into()),
        database: session.database.clone(),
        user: params.user.clone().filter(|user| !user.is_empty()),
        tls: params.tls.mode != nexo_driver_sdk::protocol::TlsMode::Disable,
    })
}

/// Hive's plan of a statement: `EXPLAIN` answers it as text.
pub async fn explain(session: &Session, sql: &str) -> Result<Plan> {
    let sql = format!("EXPLAIN {}", sql.trim().trim_end_matches(';'));
    let operation = session.start(&sql).await?;
    let (_, rows) = session.read_all(operation, 10_000).await?;
    let original = rows
        .iter()
        .map(|row| match row.first() {
            Some(nexo_driver_sdk::Value::Text(text)) => text.clone(),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    // Hive's plan is text: its first stage names the plan in the viewer.
    let nodes = original
        .lines()
        .filter(|line| line.trim_start().starts_with("Stage-") && line.contains(':'))
        .take(1)
        .map(|line| PlanNode {
            operation: line.trim().trim_end_matches(':').to_owned(),
            ..PlanNode::default()
        })
        .collect();
    Ok(Plan {
        mode: ExplainMode::Estimated,
        nodes,
        format: "text".into(),
        original,
        total_ms: None,
        rolled_back: false,
    })
}
