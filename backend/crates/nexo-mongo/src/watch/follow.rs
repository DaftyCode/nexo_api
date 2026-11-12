//! Reading a change stream in the background, and opening it again after its last change
//! when the connection drops.
use super::*;

/// Server errors after which a change stream resumes, for servers older than 4.4 that do not
/// label them (the change streams specification): a server shutting down or stepping down,
/// a lost host, a stale shard.
const RESUMABLE: [i32; 17] = [
    6, 7, 63, 89, 91, 133, 150, 189, 234, 262, 9001, 10107, 11600, 11602, 13388, 13435, 13436,
];

/// Whether opening again after the last change may work: a lost connection or a server
/// restarting, not a refusal.
pub(super) fn transient(error: &DriverError) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Command(command) => {
            error.contains_label("ResumableChangeStreamError") || RESUMABLE.contains(&command.code)
        }
        ErrorKind::Authentication { .. } | ErrorKind::InvalidArgument { .. } => false,
        _ => true,
    }
}

/// Reads the changes until the stream ends, gives up or is closed.
pub(super) async fn follow(
    client: Client,
    plan: Plan,
    mut stream: ChangeStream<Document>,
    log: Arc<Mutex<Log>>,
) {
    loop {
        let error = match stream.next_if_any().await {
            Ok(Some(change)) => {
                let kind = change
                    .get_str("operationType")
                    .unwrap_or("change")
                    .to_string();
                lock(&log).emit(&kind, Bson::Document(change).into_canonical_extjson());
                continue;
            }
            Ok(None) if stream.is_alive() => continue,
            // An `invalidate` (the collection was dropped or renamed) ends the stream.
            Ok(None) => {
                lock(&log).set("closed");
                return;
            }
            Err(error) => error,
        };
        if !transient(&error) {
            let mut log = lock(&log);
            log.emit("error", json!({ "message": explain(error).to_string() }));
            log.set("error");
            return;
        }
        let token = stream.resume_token();
        let mut attempt = 0;
        stream = loop {
            attempt += 1;
            if attempt > RETRIES {
                let mut log = lock(&log);
                log.emit("error", json!({ "message": format!("The connection was lost and could not be opened again {RETRIES} times") }));
                log.set("error");
                return;
            }
            {
                let mut log = lock(&log);
                log.set("connecting");
                log.emit(
                    "reconnecting",
                    json!({ "attempt": attempt, "message": explain(error.clone()).to_string() }),
                );
            }
            tokio::time::sleep(Duration::from_secs(u64::from(attempt.min(5)))).await;
            match open(&client, &plan, token.clone()).await {
                Ok(next) => break next,
                Err(failure) if transient(&failure) => continue,
                Err(failure) => {
                    let mut log = lock(&log);
                    log.emit("error", json!({ "message": explain(failure).to_string() }));
                    log.set("error");
                    return;
                }
            }
        };
        let mut log = lock(&log);
        log.set("connected");
        log.emit("resumed", json!({ "attempt": attempt }));
    }
}
