use nexo_server::{Config, serve};
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let directory = std::env::current_dir()?;
    let mode = std::env::var("NEXO_MODE").unwrap_or_else(|_| "local".into());
    let address = std::env::var("NEXO_BIND").unwrap_or_else(|_| {
        if mode == "server" {
            "0.0.0.0:8080".into()
        } else {
            "127.0.0.1:8080".into()
        }
    });
    let config=Config{data:PathBuf::from(std::env::var("NEXO_DATA_DIR").unwrap_or_else(|_|directory.join(".nexo").to_string_lossy().into())),node:PathBuf::from(std::env::var("NEXO_NODE").unwrap_or_else(|_|"node".into())),engine:PathBuf::from(std::env::var("NEXO_ENGINE_SCRIPT").unwrap_or_else(|_|directory.join("engine/dist/engine.mjs").to_string_lossy().into())),mode,token:None,allow_signup:std::env::var("NEXO_ALLOW_SIGNUP").is_ok_and(|v|v=="true"),origins:std::env::var("NEXO_ORIGINS").unwrap_or_else(|_|"http://localhost:4200,http://localhost:4000,http://127.0.0.1:4200,http://127.0.0.1:4000,http://localhost:8080".into()).split(',').map(String::from).collect()};
    let port = serve(config, &address).await?;
    println!("Nexo API ready on port {port}");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
