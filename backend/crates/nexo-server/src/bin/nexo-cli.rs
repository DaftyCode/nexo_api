use nexo_application::{operations::Operation, ports::ExecutionGateway};
use nexo_engine::Engine;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

const HELP: &str = "Nexo API CLI

  nexo-cli run <collection.json> [options]
  nexo-cli request <request.json> [--insecure]
  nexo-cli import <input.yaml|json|har|txt> --report <collection.json>

Run options:
  --environment <file>   Environment JSON (portable format)
  --globals <file>       Global variables JSON
  --env-var <key=value>  Environment variable; repeatable
  --iterations <n>       Iterations (default 1)
  --data <file>          Iteration data as a JSON array or CSV file
  --timeout <seconds>    Stop the run after this time (default 600)
  --insecure             Do not verify TLS certificates
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
        Ok(match command.as_str() {
            "import" => {
                engine
                    .execute(Operation::Import, json!({"content":source}))
                    .await?
            }
            "request" => {
                let request: Value = serde_json::from_str(&source)
                    .map_err(|e| format!("{source_path} is not valid JSON: {e}"))?;
                engine
                    .execute(
                        Operation::Request,
                        json!({"request":request,"strictSSL":strict}),
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
                        engine
                            .execute(Operation::DatasetParse, json!({"content":content}))
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
                let started = engine
                    .execute(
                        Operation::Run,
                        json!({"collection":collection,"variables":variables,"globals":globals,
                            "data":data,"iterations":iterations,"strictSSL":strict,
                            "globalTimeout":timeout * 1000}),
                    )
                    .await?;
                let deadline = Instant::now() + Duration::from_secs(timeout + 5);
                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let result = engine
                        .execute(
                            Operation::Run,
                            json!({"action":"status","id":started["id"]}),
                        )
                        .await?;
                    if result["state"] != "running" {
                        break result;
                    }
                    if Instant::now() > deadline {
                        engine
                            .execute(Operation::Cancel, json!({"id":started["id"]}))
                            .await?;
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
}
