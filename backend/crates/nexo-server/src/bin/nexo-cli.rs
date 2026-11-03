use nexo_domain::Actor;
use nexo_infrastructure::executor::NodeExecutor;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 || args.iter().any(|x| x == "--help") {
        println!(
            "Nexo API CLI\n\n  nexo-cli run collection.json [--environment env.json] [--iterations N] [--data rows.json] [--report result.json] [--junit result.xml]\n  nexo-cli request request.json\n  nexo-cli import input.yaml --report collection.json\n\nScripts, variables, authentication and transport share the desktop/server execution adapter."
        );
        return Ok(());
    }
    let flag = |name: &str| {
        args.iter()
            .position(|x| x == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let directory = std::env::current_dir()?;
    let executor = Arc::new(
        NodeExecutor::spawn(
            PathBuf::from(std::env::var("NEXO_NODE").unwrap_or_else(|_| "node".into())),
            PathBuf::from(std::env::var("NEXO_ENGINE_SCRIPT").unwrap_or_else(|_| {
                directory
                    .join("engine/dist/engine.mjs")
                    .to_string_lossy()
                    .into()
            })),
            directory.join(".nexo-cli"),
            std::env::var("NEXO_MASTER_KEY").ok(),
        )
        .await?,
    );
    let actor = Actor::local();
    let source = tokio::fs::read_to_string(&args[1]).await?;
    let result = if args[0] == "import" {
        executor
            .dispatch(&actor, "import", json!({"content":source}))
            .await?
    } else if args[0] == "request" {
        executor
            .dispatch(
                &actor,
                "request",
                json!({"request":serde_json::from_str::<Value>(&source)?}),
            )
            .await?
    } else if args[0] == "run" {
        let variables = if let Some(path) = flag("--environment") {
            let environment: Value = serde_json::from_str(&tokio::fs::read_to_string(path).await?)?;
            environment.get("values").cloned().unwrap_or(environment)
        } else {
            json!([])
        };
        let data = if let Some(path) = flag("--data") {
            serde_json::from_str::<Value>(&tokio::fs::read_to_string(path).await?)?
        } else {
            json!([])
        };
        let started=executor.dispatch(&actor,"run",json!({"collection":serde_json::from_str::<Value>(&source)?,"variables":variables,"data":data,"iterations":flag("--iterations").and_then(|x|x.parse::<u32>().ok()).unwrap_or(1)})).await?;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let result = executor
                .dispatch(&actor, "run", json!({"action":"status","id":started["id"]}))
                .await?;
            if result["state"] != "running" {
                break result;
            }
        }
    } else {
        return Err("Unknown command; use --help".into());
    };
    if let Some(path) = flag("--report") {
        tokio::fs::write(
            path,
            serde_json::to_vec_pretty(if args[0] == "import" {
                &result["value"]
            } else {
                &result
            })?,
        )
        .await?;
    }
    if let Some(path) = flag("--junit") {
        let tests = result["assertions"].as_array().cloned().unwrap_or_default();
        let escape = |s: &str| {
            s.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
        };
        let cases = tests
            .iter()
            .map(|test| {
                let name = escape(test["name"].as_str().unwrap_or("Assertion"));
                if test["passed"] == true {
                    format!("<testcase name=\"{name}\"/>")
                } else {
                    format!(
                        "<testcase name=\"{name}\"><failure>{}</failure></testcase>",
                        escape(test["error"].as_str().unwrap_or("Assertion failed"))
                    )
                }
            })
            .collect::<String>();
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><testsuite name=\"Nexo\" tests=\"{}\" failures=\"{}\">{cases}</testsuite>",
            tests.len(),
            tests.iter().filter(|x| x["passed"] != true).count()
        );
        tokio::fs::write(path, xml).await?;
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    let failed = result["state"] == "failed"
        || result["error"].as_str().is_some()
        || result["assertions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x["passed"] == false));
    drop(executor);
    if failed {
        std::process::exit(1);
    }
    Ok(())
}
