//! Running the steps of a collection: scripts, requests, tests and the next request.
use super::*;

/// Runs every step. Variables changed before a failure are still returned.
pub(super) async fn execute(
    payload: &Value,
    job: &Job,
    jars: &Jars,
    context: &Context,
) -> Result<Outcome> {
    let mut outcome = Outcome {
        environment: values(&payload["variables"]),
        globals: values(&payload["globals"]),
        collection: Map::new(),
        failure: None,
    };
    if let Err(error) = run_steps(payload, job, jars, context, &mut outcome).await {
        outcome.failure = Some(error.to_string());
    }
    Ok(outcome)
}
pub(super) async fn run_steps(
    payload: &Value,
    job: &Job,
    jars: &Jars,
    context: &Context,
    outcome: &mut Outcome,
) -> Result<()> {
    let collection = as_collection(payload)?;
    let mut steps = Vec::new();
    flatten(&collection, &[], &mut steps);
    let secrets = session_secrets(payload);
    let restricted = crate::secret_hosts::restricted(payload);
    // Files chosen for this request; collection runs from the interface bring none.
    let files = crate::files::Files::from_payload(payload)?;
    let jar = jars.get(&cookie_scope(payload));
    let workspace = payload["workspace"].as_str().unwrap_or_default();
    outcome.collection = values(&collection["variable"]);
    let mut local = Map::new();
    let iterations = payload["iterations"].as_u64().unwrap_or(1).clamp(1, 10_000);
    let mut deadline = Instant::now()
        + Duration::from_millis(
            payload["globalTimeout"]
                .as_u64()
                .unwrap_or(300_000)
                .min(3_600_000),
        );
    // Postman's "Delay" between requests, up to a minute.
    let delay = Duration::from_millis(payload["delay"].as_u64().unwrap_or(0).min(60_000));
    let mut first = true;
    let mut transports: HashMap<String, Transport> = HashMap::new();
    'iterations: for iteration in 0..iterations {
        let mut index = 0usize;
        let mut steps_taken = 0usize;
        while index < steps.len() {
            if job.cancelled.load(Ordering::Relaxed) {
                return Err(Error::Validation("Execution cancelled".into()));
            }
            // Waits the delay between requests, and while paused; time paused does not count
            // towards the run time limit.
            let waited = if first {
                job.wait_while_paused().await?
            } else {
                job.delay(delay).await?
            };
            first = false;
            deadline += waited;
            if Instant::now() > deadline || steps_taken > 10_000 {
                return Err(Error::Validation("Execution exceeded time limit".into()));
            }
            steps_taken += 1;
            let step = &steps[index];
            let item = &step.item;
            let request = step.request();
            let layered = step.layered_variables();
            let mut collection_variables = outcome.collection.clone();
            collection_variables.extend(layered.clone());
            let seed = json!({
                "environment": outcome.environment,
                "globals": outcome.globals,
                "local": local,
                "collection": collection_variables,
                "data": payload["data"].get(iteration as usize).cloned().unwrap_or(json!({})),
                "secrets": secrets,
                "request": request,
                "iteration": iteration,
                "iterationCount": iterations,
                "requestName": item["name"],
                "requestId": item["id"],
                "uuid": uuid::Uuid::new_v4().to_string(),
            });
            let transport_key = item["nexoTransport"]
                .as_str()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or("")
                .to_string();
            if !transports.contains_key(&transport_key) {
                let settings = if transport_key.is_empty() {
                    transport_settings(
                        payload
                            .get("transport")
                            .unwrap_or(&payload["request"]["transport"]),
                    )?
                } else {
                    transport_settings(&Value::String(transport_key.clone()))?
                };
                let options = Options::from_payload(
                    payload,
                    &settings,
                    context.egress.clone(),
                    (context.loopback_ports)(),
                );
                transports.insert(transport_key.clone(), Transport::new(options, jar.clone())?);
            }
            let transport = &transports[&transport_key];
            let session = ScriptSession::new(&seed, job.cancelled.clone())?;
            let groups: Vec<&Value> = step.parents.iter().chain(std::iter::once(item)).collect();
            session.run(&scripts(&groups, "prerequest"), None)?;
            send_queued(&session, transport, context, workspace).await?;
            let state = session.snapshot()?;
            if state["skip"] != true {
                // Script variables first; where restricted secrets go is read from the
                // references left in that result, right before the host fills them.
                let substituted = session.replace_variables(&state["request"])?;
                let placements = crate::secret_hosts::placements(&restricted, &substituted);
                let mut outgoing = session.fill_secrets(&substituted);
                files.attach(&mut outgoing);
                let url = request_url(&outgoing["url"]);
                outgoing["url"] = json!(url);
                let mut result = match transport.request(&outgoing, &placements).await {
                    Ok(result) => result,
                    Err(error) => {
                        outcome.failure.get_or_insert_with(|| error.to_string());
                        json!({"url": url, "method": outgoing["method"], "status": 0, "statusText": "", "body": "",
                               "headers": [], "cookies": [], "size": 0, "time": 0, "error": error.to_string()})
                    }
                };
                result["id"] = item["id"].clone();
                result["name"] = item.get("name").cloned().unwrap_or(json!(url));
                result["iteration"] = json!(iteration);
                // The contents of the files are not returned: only their names.
                result["request"] = crate::files::without_contents(outgoing);
                job.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .results
                    .push(result.clone());
                session.run(&scripts(&groups, "test"), Some(&result))?;
                send_queued(&session, transport, context, workspace).await?;
            }
            let state = session.snapshot()?;
            // `nx.oauth2.reset(name)`: the next send gets a new token (Bruno's
            // `bru.resetOauth2Credential`). Scripts can delete tokens but never read them.
            if let (Some(vault), Some(names)) = (&context.vault, state["oauth2Resets"].as_array()) {
                for name in names.iter().filter_map(Value::as_str) {
                    crate::oauth2_tokens::delete_named(vault, name).await?;
                }
            }
            outcome.environment = state["environment"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            outcome.globals = state["globals"].as_object().cloned().unwrap_or_default();
            local.extend(state["local"].as_object().cloned().unwrap_or_default());
            let collection_after = state["collection"].as_object().cloned().unwrap_or_default();
            let mut before = outcome.collection.clone();
            before.extend(layered);
            for (key, value) in &collection_after {
                if before.get(key) != Some(value) {
                    outcome.collection.insert(key.clone(), value.clone());
                }
            }
            for key in before.keys() {
                if !collection_after.contains_key(key) {
                    outcome.collection.shift_remove(key);
                }
            }
            {
                let mut shared = job.state.lock().unwrap_or_else(|e| e.into_inner());
                shared
                    .assertions
                    .extend(state["assertions"].as_array().cloned().unwrap_or_default());
                let room = 1000usize.saturating_sub(shared.logs.len());
                shared.logs.extend(
                    state["logs"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .take(room),
                );
            }
            match &state["next"] {
                Value::Null if state.get("next").is_some() => break 'iterations,
                Value::String(next) => {
                    let target = steps
                        .iter()
                        .position(|s| {
                            s.item["id"].as_str() == Some(next)
                                || s.item["name"].as_str() == Some(next)
                        })
                        .ok_or_else(|| Error::Validation("Next request was not found".into()))?;
                    index = target;
                    continue;
                }
                _ => {}
            }
            index += 1;
        }
    }
    Ok(())
}

/// Sends requests queued by `pm.sendRequest` and `nx.mongo` calls, and delivers their
/// answers, until a round queues nothing more.
pub(super) async fn send_queued(
    session: &ScriptSession,
    transport: &Transport,
    context: &Context,
    workspace: &str,
) -> Result<()> {
    for _round in 0..100 {
        let queue = session.take_queue()?;
        let calls = session.take_mongo()?;
        if queue.is_empty() && calls.is_empty() {
            return Ok(());
        }
        if !calls.is_empty() {
            let state = session.snapshot()?;
            for (id, call) in calls {
                let variables = super::databases::variables(&state);
                match super::databases::call(&context.databases, workspace, variables, &call, None)
                    .await
                {
                    Ok(result) => session.deliver_mongo(&id, Some(&result), None)?,
                    Err(error) => session.deliver_mongo(&id, None, Some(&error.to_string()))?,
                }
            }
        }
        for (id, request) in queue {
            let mut request = request;
            if let Some(url) = request.get("url").map(request_url) {
                request["url"] = json!(url);
            }
            // Scripts cannot use vault secrets, so their requests carry none.
            match transport.request(&request, &[]).await {
                Ok(result) => session.deliver(&id, Some(&result), None)?,
                Err(error) => session.deliver(&id, None, Some(&error.to_string()))?,
            }
        }
    }
    Err(Error::Validation("Script request limit exceeded".into()))
}
