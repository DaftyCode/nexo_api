//! An index's sheet (its figures, fields, settings and aliases) and the request that makes
//! an index or a template again.
use super::{get, index_fields, text};
use crate::http::Client;
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Ddl, ObjectDescription, Property, Section},
};
use serde_json::{Map, Value as Json};

pub(super) fn flatten(value: &Json, prefix: &str, out: &mut Vec<Vec<Value>>) {
    match value {
        Json::Object(map) => {
            for (name, inner) in map {
                flatten(inner, &format!("{prefix}{name}."), out);
            }
        }
        other => out.push(vec![
            Value::Text(prefix.trim_end_matches('.').to_owned()),
            Value::Text(text(other)),
        ]),
    }
}

pub(crate) async fn describe(client: &Client, path: &[String]) -> Result<ObjectDescription> {
    let [folder, index] = path else {
        return Err(DriverError::invalid("Choose an index"));
    };
    if folder != "indices" {
        return Err(DriverError::invalid("Only an index has a sheet"));
    }
    let stats = get(
        client,
        &format!("/_cat/indices/{index}?format=json&bytes=b"),
    )
    .await?;
    let row = &stats[0];
    let properties = [
        "health",
        "status",
        "docs.count",
        "docs.deleted",
        "store.size",
        "pri",
        "rep",
        "uuid",
    ]
    .iter()
    .map(|name| Property {
        name: (*name).into(),
        value: Value::Text(text(&row[*name])),
    })
    .collect();
    let fields = index_fields(client, index).await?;
    let settings = get(client, &format!("/{index}/_settings?flat_settings=false")).await?;
    let mut setting_rows = Vec::new();
    if let Some(found) = settings.as_object().and_then(|all| all.values().next()) {
        flatten(&found["settings"], "", &mut setting_rows);
    }
    let aliases = get(client, &format!("/{index}/_alias")).await?;
    let alias_rows = aliases
        .as_object()
        .and_then(|all| all.values().next())
        .and_then(|value| value["aliases"].as_object())
        .map(|found| {
            found
                .keys()
                .map(|name| vec![Value::Text(name.clone())])
                .collect()
        })
        .unwrap_or_default();
    let section = |id: &str, title: &str, columns: &[&str], rows: Vec<Vec<Value>>| Section {
        id: id.into(),
        title: title.into(),
        columns: columns.iter().map(|c| (*c).to_owned()).collect(),
        rows,
    };
    Ok(ObjectDescription {
        kind: "table".into(),
        name: index.clone(),
        properties,
        sections: vec![
            section(
                "columns",
                "Fields",
                &["Name", "Type"],
                fields
                    .into_iter()
                    .map(|(n, k)| vec![Value::Text(n), Value::Text(k)])
                    .collect(),
            ),
            section("settings", "Settings", &["Setting", "Value"], setting_rows),
            section("aliases", "Aliases", &["Alias"], alias_rows),
        ],
    })
}

/// The settings of an index that the server sets by itself: never part of the request that
/// makes it again.
const OWN_SETTINGS: [&str; 5] = [
    "uuid",
    "creation_date",
    "version",
    "provided_name",
    "routing",
];

pub(crate) async fn ddl(client: &Client, path: &[String]) -> Result<Ddl> {
    let (sql, body) = match path {
        [folder, index] if folder == "indices" => {
            let found = get(client, &format!("/{index}")).await?;
            let mut value = found
                .as_object()
                .and_then(|all| all.values().next())
                .cloned()
                .unwrap_or_default();
            if let Some(settings) = value["settings"]["index"].as_object_mut() {
                for own in OWN_SETTINGS {
                    settings.remove(own);
                }
            }
            (format!("PUT /{index}"), value)
        }
        [folder, template] if folder == "templates" => {
            let found = get(client, &format!("/_index_template/{template}")).await?;
            (
                format!("PUT /_index_template/{template}"),
                found["index_templates"][0]["index_template"].clone(),
            )
        }
        _ => {
            return Err(DriverError::invalid(
                "Only an index or a template is written as a request",
            ));
        }
    };
    let body = Json::Object(body.as_object().cloned().unwrap_or_else(Map::new));
    Ok(Ddl {
        sql: format!(
            "{sql}\n{}",
            serde_json::to_string_pretty(&body).unwrap_or_default()
        ),
    })
}
