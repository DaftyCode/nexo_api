use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_application::{operations::Operation, payloads, ports::ExecutionGateway};
use nexo_engine::Engine;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const HELP: &str = "Nexo API CLI

  nexo-cli run <collection.json> [options]
  nexo-cli request <request.json> [--insecure] [--working-dir <dir>]
  nexo-cli import <input.yaml|json|har|txt> --report <collection.json>

Run options:
  --environment <file>   Environment JSON (portable format)
  --globals <file>       Global variables JSON
  --env-var <key=value>  Environment variable; repeatable
  --iterations <n>       Iterations (default 1)
  --data <file>          Iteration data as a JSON array or CSV file
  --timeout <seconds>    Stop the run after this time (default 600)
  --insecure             Do not verify TLS certificates
  --working-dir <dir>    Folder of the files that form-data fields and binary bodies send
                         (default: the folder of the collection)
  --report <file>        Write the result as JSON
  --junit <file>         Write a JUnit XML report

Environment: NEXO_DATA_DIR keeps data between invocations; NEXO_MASTER_KEY sets the vault key.";

struct Arguments {
    values: Vec<String>,
}
impl Arguments {
    fn flag(&self, name: &str) -> Option<String> {
        self.values
            .iter()
            .position(|x| x == name)
            .and_then(|i| self.values.get(i + 1))
            .cloned()
    }
    fn all(&self, name: &str) -> Vec<String> {
        self.values
            .windows(2)
            .filter(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
            .collect()
    }
    fn has(&self, name: &str) -> bool {
        self.values.iter().any(|x| x == name)
    }
}

fn read_json(path: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(serde_json::from_str(&text).map_err(|e| format!("{path} is not valid JSON: {e}"))?)
}
/// The files a collection or request sends (form-data `file` fields and binary bodies), read
/// from `folder` when their paths are relative, as `files` for the engine. A request uses each
/// entry once, so a name referenced twice in one request is sent twice.
fn files(source: &Value, folder: &Path) -> Value {
    fn requests<'a>(node: &'a Value, found: &mut Vec<&'a Value>) {
        if let Some(items) = node["item"].as_array() {
            items.iter().for_each(|item| requests(item, found));
        }
        if node["request"].is_object() {
            found.push(&node["request"]);
        } else if node["body"].is_object() {
            found.push(node);
        }
    }
    let mut found = Vec::new();
    requests(source, &mut found);
    let mut needed: Vec<(String, usize)> = Vec::new();
    for request in found {
        let body = &request["body"];
        let mut names: Vec<String> = match body["mode"].as_str() {
            Some("formdata") => body["formdata"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| nexo_engine::files::is_file(row) && row["disabled"] != true)
                .flat_map(|row| nexo_engine::files::sources(&row["src"]))
                .collect(),
            Some("file") => nexo_engine::files::sources(&body["file"]["src"]),
            _ => Vec::new(),
        };
        names.sort();
        for name in names.chunk_by(|a, b| a == b) {
            match needed.iter_mut().find(|(src, _)| src == &name[0]) {
                Some((_, count)) => *count = (*count).max(name.len()),
                None => needed.push((name[0].clone(), name.len())),
            }
        }
    }
    let mut read: HashMap<String, String> = HashMap::new();
    let mut entries = Vec::new();
    for (src, count) in needed {
        let path = folder.join(&src);
        let content = match read.get(&src) {
            Some(content) => content.clone(),
            None => match std::fs::read(&path) {
                Ok(bytes) => {
                    let content = STANDARD.encode(bytes);
                    read.insert(src.clone(), content.clone());
                    content
                }
                // The request reports the file it could not send.
                Err(error) => {
                    eprintln!("Cannot read {}: {error}", path.display());
                    continue;
                }
            },
        };
        for _ in 0..count {
            entries.push(json!({"src": src, "content": content}));
        }
    }
    Value::Array(entries)
}
fn rows(value: Value) -> Value {
    value.get("values").cloned().unwrap_or(value)
}
/// Characters XML 1.0 does not allow, removed from JUnit output.
fn xml(text: &str) -> String {
    text.chars()
        .filter(|c| matches!(c, '\t' | '\n' | '\r') || !c.is_control())
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn junit(result: &Value, seconds: f64) -> String {
    let tests = result["assertions"].as_array().cloned().unwrap_or_default();
    let failures = tests.iter().filter(|x| x["passed"] == false).count();
    let skipped = tests.iter().filter(|x| x["skipped"] == true).count();
    let cases = tests
        .iter()
        .map(|test| {
            let name = xml(test["name"].as_str().unwrap_or("Assertion"));
            let class = format!("iteration-{}", test["iteration"].as_u64().unwrap_or(0) + 1);
            if test["skipped"] == true {
                format!("<testcase classname=\"{class}\" name=\"{name}\"><skipped/></testcase>")
            } else if test["passed"] == true {
                format!("<testcase classname=\"{class}\" name=\"{name}\"/>")
            } else {
                format!(
                    "<testcase classname=\"{class}\" name=\"{name}\"><failure message=\"{}\"/></testcase>",
                    xml(test["error"].as_str().unwrap_or("Assertion failed"))
                )
            }
        })
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><testsuites tests=\"{}\" failures=\"{failures}\" time=\"{seconds:.3}\"><testsuite name=\"Nexo\" tests=\"{}\" failures=\"{failures}\" skipped=\"{skipped}\" time=\"{seconds:.3}\">{cases}</testsuite></testsuites>",
        tests.len(),
        tests.len()
    )
}

/// Runs an operation with its payload checked as the API checks it.
async fn execute(
    engine: &Engine,
    operation: Operation,
    payload: Value,
) -> Result<Value, nexo_domain::Error> {
    engine
        .execute(operation, payloads::validate(operation, payload)?)
        .await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let values: Vec<String> = std::env::args().skip(1).collect();
    if values.len() < 2 || values.iter().any(|x| x == "--help" || x == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let args = Arguments { values };
    let command = args.values[0].clone();
    if !["run", "request", "import"].contains(&command.as_str()) {
        return Err("Unknown command; use --help".into());
    }
    let source_path = args.values[1].clone();
    // Each invocation uses its own temporary data directory, removed at the end.
    let data = std::env::var_os("NEXO_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("nexo-cli-{}", uuid::Uuid::new_v4())));
    let temporary = std::env::var_os("NEXO_DATA_DIR").is_none();
    let engine = Engine::new(&data, std::env::var("NEXO_MASTER_KEY").ok())?;
    let started = Instant::now();
    let outcome: Result<Value, Box<dyn std::error::Error>> = async {
        let source = std::fs::read_to_string(&source_path)
            .map_err(|e| format!("Cannot read {source_path}: {e}"))?;
        let strict = !args.has("--insecure");
        let folder = args
            .flag("--working-dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(&source_path)
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default()
            });
        Ok(match command.as_str() {
            "import" => execute(&engine, Operation::Import, json!({"content":source})).await?,
            "request" => {
                let request: Value = serde_json::from_str(&source)
                    .map_err(|e| format!("{source_path} is not valid JSON: {e}"))?;
                execute(
                    &engine,
                    Operation::Request,
                    json!({"request":request,"strictSSL":strict,"files":files(&request, &folder)}),
                )
                .await?
            }
            _ => {
                let mut variables = match args.flag("--environment") {
                    Some(path) => rows(read_json(&path)?),
                    None => json!([]),
                };
                for pair in args.all("--env-var") {
                    let (key, value) = pair
                        .split_once('=')
                        .ok_or_else(|| format!("--env-var expects key=value, not {pair}"))?;
                    variables
                        .as_array_mut()
                        .ok_or("The environment file must contain a values array")?
                        .push(json!({"key":key,"value":value,"enabled":true}));
                }
                let globals = match args.flag("--globals") {
                    Some(path) => rows(read_json(&path)?),
                    None => json!([]),
                };
                let data = match args.flag("--data") {
                    Some(path) => {
                        let content = std::fs::read_to_string(&path)
                            .map_err(|e| format!("Cannot read {path}: {e}"))?;
                        execute(&engine, Operation::DatasetParse, json!({"content":content}))
                            .await?["rows"]
                            .clone()
                    }
                    None => json!([]),
                };
                let iterations = match args.flag("--iterations") {
                    Some(value) => value
                        .parse::<u32>()
                        .map_err(|_| format!("--iterations expects a number, not {value}"))?,
                    None => 1,
                };
                let timeout = match args.flag("--timeout") {
                    Some(value) => value
                        .parse::<u64>()
                        .map_err(|_| format!("--timeout expects seconds, not {value}"))?,
                    None => 600,
                };
                let collection: Value = serde_json::from_str(&source)
                    .map_err(|e| format!("{source_path} is not valid JSON: {e}"))?;
                let started = execute(
                    &engine,
                    Operation::Run,
                    json!({"collection":collection,"variables":variables,"globals":globals,
                            "data":data,"iterations":iterations,"strictSSL":strict,
                            "globalTimeout":timeout * 1000,"files":files(&collection, &folder)}),
                )
                .await?;
                let deadline = Instant::now() + Duration::from_secs(timeout + 5);
                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let result = execute(
                        &engine,
                        Operation::Run,
                        json!({"action":"status","id":started["id"]}),
                    )
                    .await?;
                    if result["state"] != "running" {
                        break result;
                    }
                    if Instant::now() > deadline {
                        execute(&engine, Operation::Cancel, json!({"id":started["id"]})).await?;
                        return Err(format!("The run exceeded {timeout} seconds").into());
                    }
                }
            }
        })
    }
    .await;
    engine.close();
    if temporary {
        let _ = std::fs::remove_dir_all(&data);
    }
    let result = outcome?;
    if let Some(path) = args.flag("--report") {
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(if command == "import" {
                &result["value"]
            } else {
                &result
            })?,
        )?;
    }
    if let Some(path) = args.flag("--junit") {
        std::fs::write(&path, junit(&result, started.elapsed().as_secs_f64()))?;
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    let failed = result["state"] == "failed"
        || result["error"].as_str().is_some()
        || result["assertions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x["passed"] == false));
    if failed {
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn junit_escapes_and_counts() {
        let report = junit(
            &json!({"assertions":[
                {"name":"ok <1>","passed":true,"iteration":0},
                {"name":"bad\u{0001}","passed":false,"error":"x & y","iteration":1},
                {"name":"later","passed":true,"skipped":true}
            ]}),
            1.5,
        );
        assert!(report.contains("tests=\"3\" failures=\"1\""));
        assert!(report.contains("ok &lt;1&gt;"));
        assert!(report.contains("x &amp; y"));
        assert!(report.contains("<skipped/>"));
        assert!(!report.contains('\u{0001}'));
    }
    #[test]
    fn files_are_read_next_to_the_collection_once_per_use() {
        let folder = std::env::temp_dir().join(format!("nexo-cli-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(folder.join("img")).unwrap();
        std::fs::write(folder.join("img/a.png"), [1u8, 2]).unwrap();
        std::fs::write(folder.join("body.bin"), [3u8]).unwrap();
        let collection = json!({"item": [
            {"name": "Form", "request": {"body": {"mode": "formdata", "formdata": [
                {"key": "x", "type": "file", "src": "img/a.png"},
                {"key": "y", "type": "file", "src": ["img/a.png", "missing.txt"]},
                {"key": "z", "type": "file", "src": "img/a.png", "disabled": true},
                {"key": "t", "value": "text"}
            ]}}},
            {"name": "Folder", "item": [
                {"name": "Binary", "request": {"body": {"mode": "file", "file": {"src": "body.bin"}}}},
                {"name": "Again", "request": {"body": {"mode": "file", "file": {"src": "img/a.png"}}}}
            ]}
        ]});
        let entries = files(&collection, &folder);
        let names: Vec<&str> = entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["src"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["img/a.png", "img/a.png", "body.bin"]);
        assert_eq!(entries[0]["content"], STANDARD.encode([1u8, 2]));
        let request = json!({"body": {"mode": "file", "file": {"src": "body.bin"}}});
        assert_eq!(
            files(&request, &folder)[0]["content"],
            STANDARD.encode([3u8])
        );
        std::fs::remove_dir_all(folder).unwrap();
    }
}
