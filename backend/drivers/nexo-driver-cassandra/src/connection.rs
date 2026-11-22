//! A session on a Cassandra or ScyllaDB cluster (DB-34). The contact points are resolved by
//! the host, and every node the driver discovers in `system.peers` goes through the host
//! again (the address translator): a node the egress policy refuses is never connected to.
use crate::{
    translator::HostTranslator,
    values::{column, from_cql},
};
use nexo_driver_sdk::{
    Column, DriverError, HostLink, Result, Value, limits,
    protocol::{ConnectParams, TlsMode},
    tls,
};
use scylla::{
    client::{
        execution_profile::ExecutionProfile, session::Session, session_builder::SessionBuilder,
    },
    policies::load_balancing::DefaultPolicy,
    statement::{Consistency, Statement},
    value::Row,
};

/// The CQL port when a contact point names none.
pub(crate) const PORT: u16 = 9042;

/// The settings a Cassandra connection accepts, besides the common ones.
pub const SETTINGS: [&str; 3] = ["localDc", "consistency", "pageSize"];

/// The contact points written in the host field: `a,b:9043`, each one with its port.
pub(crate) fn contact_points(host: &str, port: Option<u16>) -> Vec<(String, u16)> {
    host.split(',')
        .map(str::trim)
        .filter(|point| !point.is_empty())
        .map(|point| match point.rsplit_once(':') {
            Some((name, number)) if !name.contains(':') || name.ends_with(']') => (
                name.trim_matches(['[', ']']).to_owned(),
                number.parse().unwrap_or(port.unwrap_or(PORT)),
            ),
            _ => (
                point.trim_matches(['[', ']']).to_owned(),
                port.unwrap_or(PORT),
            ),
        })
        .collect()
}

pub(crate) fn consistency(name: &str) -> Result<Consistency> {
    Ok(match name.to_ascii_uppercase().replace(' ', "_").as_str() {
        "ANY" => Consistency::Any,
        "ONE" => Consistency::One,
        "TWO" => Consistency::Two,
        "THREE" => Consistency::Three,
        "QUORUM" => Consistency::Quorum,
        "ALL" => Consistency::All,
        "LOCAL_QUORUM" => Consistency::LocalQuorum,
        "EACH_QUORUM" => Consistency::EachQuorum,
        "LOCAL_ONE" => Consistency::LocalOne,
        _ => {
            return Err(DriverError::invalid(format!(
                "Unknown consistency level {name}"
            )));
        }
    })
}

pub(crate) fn failure(error: impl std::fmt::Display) -> DriverError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    if lower.contains("authentication")
        || lower.contains("bad credentials")
        || lower.contains("password")
    {
        DriverError::auth(message)
    } else if lower.contains("syntax") || lower.contains("line ") && lower.contains("mismatched") {
        DriverError::syntax(message)
    } else if lower.contains("unauthorized") || lower.contains("permission") {
        DriverError::permission(message)
    } else if lower.contains("timed out") || lower.contains("timeout") {
        DriverError::timeout(message)
    } else if lower.contains("connect")
        || lower.contains("no known")
        || lower.contains("broken pipe")
    {
        DriverError::network(message)
    } else {
        DriverError::invalid(message)
    }
}

/// Opens a session on the cluster of a connection.
pub(crate) async fn open(
    link: &HostLink,
    params: &ConnectParams,
) -> Result<(Session, u32, Consistency)> {
    let host = params.host.as_deref().unwrap_or("localhost");
    let mut contacts = Vec::new();
    for (name, port) in contact_points(host, params.port) {
        contacts.extend(link.resolve(&params.connection, &name, port).await?);
    }
    let mut builder = SessionBuilder::new()
        .known_nodes_addr(contacts.iter().copied())
        .address_translator(HostTranslator::new(
            link.clone(),
            params.connection.clone(),
            contacts,
        ))
        .connection_timeout(limits::connect());
    if let Some(user) = params.user.as_deref().filter(|user| !user.is_empty()) {
        builder = builder.user(user, params.password.clone().unwrap_or_default());
    }
    if params.tls.mode != TlsMode::Disable
        && let Some(config) = tls::client_config(&params.tls)?
    {
        builder = builder.tls_context(Some(config));
    }
    if let Some(keyspace) = params.database.as_deref().filter(|name| !name.is_empty()) {
        builder = builder.use_keyspace(keyspace, false);
    }
    // The driver's default, LOCAL_ONE, when the connection names none.
    let level = match params
        .options
        .get("consistency")
        .filter(|level| !level.is_empty())
    {
        Some(level) => consistency(level)?,
        None => Consistency::LocalOne,
    };
    let mut profile = ExecutionProfile::builder()
        .request_timeout(Some(limits::STATEMENT))
        .consistency(level);
    if let Some(dc) = params.options.get("localDc").filter(|dc| !dc.is_empty()) {
        profile = profile.load_balancing_policy(
            DefaultPolicy::builder()
                .prefer_datacenter(dc.clone())
                .build(),
        );
    }
    builder = builder.default_execution_profile_handle(profile.build().into_handle());
    let session = builder.build().await.map_err(failure)?;
    let page = params
        .options
        .get("pageSize")
        .and_then(|size| size.parse().ok())
        .unwrap_or(limits::PAGE_ROWS);
    Ok((session, page, level))
}

/// Every row of a small query (the catalog's), page after page.
pub(crate) async fn rows(
    session: &Session,
    cql: &str,
    values: &[&str],
) -> Result<(Vec<Column>, Vec<Vec<Value>>)> {
    let mut statement = Statement::new(cql);
    statement.set_page_size(1000);
    let values: Vec<String> = values.iter().map(|value| (*value).to_owned()).collect();
    let result = if values.is_empty() {
        session.query_unpaged(statement, ()).await
    } else {
        session.query_unpaged(statement, values).await
    }
    .map_err(failure)?;
    let result = result.into_rows_result().map_err(failure)?;
    let columns = result
        .column_specs()
        .iter()
        .map(|spec| column(spec.name(), spec.typ()))
        .collect();
    let rows = result
        .rows::<Row>()
        .map_err(failure)?
        .map(|row| {
            row.map(|row| {
                row.columns
                    .iter()
                    .map(|value| from_cql(value.as_ref()))
                    .collect()
            })
        })
        .collect::<std::result::Result<_, _>>()
        .map_err(failure)?;
    Ok((columns, rows))
}

/// The text of a cell of a catalog row.
pub(crate) fn text(row: &[Value], at: usize) -> String {
    match row.get(at) {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Typed { text, .. }) => text.clone(),
        Some(Value::Integer(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| text(std::slice::from_ref(item), 0))
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}
