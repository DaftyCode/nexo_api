//! Closing what nobody uses, and keeping alive the connections that ask for it.
use super::shared::Shared;
use crate::process::DriverProcess;
use nexo_driver_sdk::{Result, methods, statements::ExecuteResult};
use std::{
    sync::{Arc, Weak},
    time::Duration,
};

/// Closes the connections nobody uses and then the drivers without connections, until the
/// host is dropped.
pub(crate) async fn close_idle(shared: Weak<Shared>, tick: Duration) {
    loop {
        tokio::time::sleep(tick).await;
        let Some(shared) = shared.upgrade() else {
            return;
        };
        keep_alive(&shared).await;
        let idle = shared.config.idle;
        for (connection, module) in shared.connections.take_idle(idle) {
            let process = shared.processes.lock().await.get(&module).cloned();
            if let Some(process) = process.filter(|process| process.alive()) {
                let params = serde_json::json!({"connection": connection});
                let limit = Some(Duration::from_secs(5));
                let _: Result<()> = shared
                    .ask(&process, methods::DISCONNECT, &params, limit)
                    .await;
            }
        }
        let unused: Vec<Arc<DriverProcess>> = {
            let mut processes = shared.processes.lock().await;
            let modules: Vec<String> = processes
                .values()
                .filter(|process| {
                    !process.alive()
                        || (process.idle_for() >= idle
                            && shared.connections.count(&process.module) == 0)
                })
                .map(|process| process.module.clone())
                .collect();
            modules
                .iter()
                .filter_map(|module| processes.remove(module))
                .collect()
        };
        for process in unused {
            shared
                .connections
                .forget_process(&process.module, process.generation);
            process.stop().await;
        }
    }
}

/// Runs the keep-alive query of each connection that is due, without counting it as a use,
/// so the connection still closes when nobody uses it. A failure says nothing here: the next
/// use finds the connection closed.
async fn keep_alive(shared: &Shared) {
    for (connection, module, generation, query) in shared.connections.due_pings() {
        let process = shared.processes.lock().await.get(&module).cloned();
        let Some(process) =
            process.filter(|process| process.alive() && process.generation == generation)
        else {
            continue;
        };
        let statement = "nexo-keep-alive";
        let params = serde_json::json!({
            "connection": connection, "statement": statement, "sql": query, "params": [],
            "pageRows": 1,
        });
        let limit = Some(Duration::from_secs(10));
        let ran: Result<ExecuteResult> =
            shared.ask(&process, methods::EXECUTE, &params, limit).await;
        if ran.is_ok_and(|answer| answer.cursor.is_some()) {
            let params = serde_json::json!({"connection": connection, "statement": statement});
            let _: Result<()> = shared.ask(&process, methods::CLOSE, &params, limit).await;
        }
    }
}
