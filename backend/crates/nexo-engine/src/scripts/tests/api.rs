//! The script API: requests sent from scripts and the suggestions of the editor.
use super::super::*;
use super::*;

#[test]
fn send_request_callbacks_are_delivered() {
    let session = session();
    session
        .run(&["pm.test('async', async () => { const r = await pm.sendRequest('http://y'); pm.environment.set('code', r.code); });".into()], None)
        .unwrap();
    let queue = session.take_queue().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].1["url"], "http://y");
    session
        .deliver(
            &queue[0].0,
            Some(&json!({"status": 201, "body": "", "headers": []})),
            None,
        )
        .unwrap();
    assert_eq!(session.snapshot().unwrap()["environment"]["code"], 201);
}
/// The editor suggests the script API from `src/app/domain/script-api.ts`: every member
/// the sandbox really has is described there, and nothing described is missing here.
#[test]
fn the_suggested_script_api_matches_the_sandbox() {
    let session = session();
    let response = json!({"status": 200, "statusText": "OK", "body": "{}", "headers": [],
                          "size": 2, "time": 1, "cookies": []});
    session
        .run(
            &[r#"
                const keys = (value) => Object.keys(value).sort();
                pm.environment.set('api', JSON.stringify({
                    pm: keys(pm),
                    environment: keys(pm.environment),
                    iterationData: keys(pm.iterationData),
                    variables: keys(pm.variables),
                    info: keys(pm.info),
                    headers: keys(pm.request.headers),
                    response: keys(pm.response),
                    responseHeaders: keys(pm.response.headers),
                    have: keys(pm.response.to.have),
                    be: keys(pm.response.to.be),
                    execution: keys(pm.execution),
                    oauth2: keys(pm.oauth2),
                    same: pm === nx,
                }));
            "#
            .into()],
            Some(&response),
        )
        .unwrap();
    let state = session.snapshot().unwrap();
    let live: Value = serde_json::from_str(state["environment"]["api"].as_str().unwrap()).unwrap();
    assert_eq!(live["same"], true);
    // The names the editor knows: the first argument of each entry in the TypeScript file.
    let described = include_str!("../../../../../../src/app/domain/script-api.ts");
    let mut known = std::collections::BTreeSet::new();
    // The formatter may break the call before its first argument.
    for kind in ["method(", "property(", "object("] {
        for part in described.split(kind).skip(1) {
            if let Some(name) = part.trim_start().strip_prefix('\'') {
                known.insert(name.split('\'').next().unwrap().to_string());
            }
        }
    }
    // Scopes and headers list their names in arrays of the same file.
    for name in [
        "get",
        "has",
        "set",
        "unset",
        "clear",
        "toObject",
        "replaceIn",
        "all",
        "add",
        "upsert",
        "remove",
        "text",
        "json",
    ] {
        assert!(known.contains(name), "{name} is not described");
    }
    for (group, names) in live.as_object().unwrap() {
        for name in names.as_array().into_iter().flatten() {
            let name = name.as_str().unwrap();
            assert!(
                known.contains(name),
                "pm {group}.{name} is not described for the editor"
            );
        }
    }
    // And what is described for pm exists.
    let top: Vec<&str> = live["pm"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for name in [
        "environment",
        "globals",
        "collectionVariables",
        "iterationData",
        "variables",
        "info",
        "request",
        "response",
        "test",
        "expect",
        "execution",
        "oauth2",
        "sendRequest",
    ] {
        assert!(
            top.contains(&name),
            "{name} is described but pm has no such member"
        );
    }
}
