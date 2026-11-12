//! The MongoDB shell: commands written as in mongosh, run in a QuickJS context of their own
//! with the script API, its time and memory limits and its sandbox. Every call to the
//! database is an `nx.mongo` call that the application answers with the interface's rules;
//! destructive ones (`drop`, `dropDatabase`, `deleteMany({})`) need the name the person
//! typed (`confirm`). Each command gets a fresh context: the current database travels with
//! the command, variables do not.
use crate::{
    runner::{ScriptDatabases, databases},
    scripts::ScriptSession,
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

const SHELL: &str = include_str!("shell.js");
/// Documents of a cursor shown when the command does not set a limit.
const SHOWN: u64 = 50;
/// Calls to the database one command may make.
const CALLS: usize = 100;

/// `use name` and `show what` lines as calls, the rest as written.
pub(crate) fn translate(command: &str) -> String {
    command
        .lines()
        .map(|line| {
            let words: Vec<&str> = line
                .trim()
                .trim_end_matches(';')
                .split_whitespace()
                .collect();
            match words.as_slice() {
                ["use", name] => format!("use({});", json!(name)),
                ["show", what] => format!("show({});", json!(what)),
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Runs a command on its own thread, as scripts run, and answers what it gave.
pub async fn run(databases: ScriptDatabases, payload: Value) -> Result<Value> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("nexo-shell".into())
        .spawn(move || {
            let outcome = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| Error::Infrastructure(error.to_string()))
                .and_then(|runtime| runtime.block_on(command(&databases, &payload)));
            let _ = sender.send(outcome);
        })
        .map_err(|error| Error::Infrastructure(error.to_string()))?;
    receiver
        .await
        .map_err(|_| Error::Infrastructure("The shell stopped".into()))?
}

async fn command(databases: &ScriptDatabases, payload: &Value) -> Result<Value> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default().to_string();
    let source = text("command");
    if source.trim().is_empty() {
        return Err(Error::Validation("Write a command".into()));
    }
    let started = Instant::now();
    let seed = json!({
        "environment": {}, "globals": {}, "local": {}, "collection": {}, "data": {},
        "request": {"method": "GET", "url": "", "header": []},
        "iteration": 0, "iterationCount": 1, "requestName": "shell", "requestId": "shell",
        "uuid": uuid::Uuid::new_v4().to_string(),
    });
    let session = ScriptSession::new(&seed, Arc::new(AtomicBool::new(false)))?;
    let config =
        json!({"connection": text("connection"), "database": text("database"), "shown": SHOWN});
    session.evaluate_into(&format!("{SHELL}({config})"), "__shellSetup")?;
    session.evaluate_into(&translate(&source), "__shellValue")?;
    session.evaluate_into("__shell.settle(__shellValue)", "__shellSettle")?;
    let workspace = text("workspace");
    let variables: Map<String, Value> = payload["variables"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let confirm = payload["confirm"].as_str().map(String::from);
    let mut calls = 0;
    loop {
        let queued = session.take_mongo()?;
        if queued.is_empty() {
            break;
        }
        for (id, call) in queued {
            calls += 1;
            if calls > CALLS {
                return Err(Error::Validation(format!(
                    "A command makes at most {CALLS} calls to the database"
                )));
            }
            let answer = databases::call(
                databases,
                &workspace,
                variables.clone(),
                &call,
                confirm.clone(),
            )
            .await;
            match answer {
                Ok(result) => session.deliver_mongo(&id, Some(&result), None)?,
                Err(error) => session.deliver_mongo(&id, None, Some(&error.to_string()))?,
            }
        }
    }
    let output: Value = serde_json::from_str(&session.output()?)
        .map_err(|error| Error::Infrastructure(error.to_string()))?;
    if let Some(error) = output["error"].as_str() {
        return Err(Error::Validation(error.to_string()));
    }
    let logs: Vec<Value> = session.snapshot()?["logs"]
        .as_array()
        .map(|logs| logs.iter().map(|log| json!(log["values"])).collect())
        .unwrap_or_default();
    Ok(json!({
        "database": output["database"],
        "kind": output["kind"],
        "value": output["value"],
        "logs": logs,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests;
