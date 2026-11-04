//! Local web launcher: starts Nexo on 127.0.0.1 and opens it in the browser.
use nexo_server::{config, serve, write_private};
use serde_json::{Value, json};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", config::HELP);
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tower_http=warn")),
        )
        .init();
    let launch = config::parse(
        &args,
        |name| std::env::var(name).ok(),
        &std::env::current_exe()?,
    )?;
    let instance = launch.config.data.join("web-instance.json");

    // Already running: ask that instance for a new one-time link instead of starting again.
    if let Some(url) = existing_instance(&instance).await {
        println!("Nexo is already running. Open: {url}");
        if launch.open {
            open_browser(&url);
        }
        return Ok(());
    }

    let token = launch.config.token.clone();
    let running = serve(launch.config, &format!("127.0.0.1:{}", launch.port)).await?;
    let base = format!("http://127.0.0.1:{}", running.port);
    write_private(
        &instance,
        &json!({"port": running.port, "token": token, "pid": std::process::id()}).to_string(),
    )?;
    let url = format!(
        "{base}/api/session/open?code={}",
        running.sessions.issue_link()
    );
    println!("Nexo API is running at {base}");
    println!("Sign-in link (valid once for two minutes): {url}");
    if launch.open {
        open_browser(&url);
    }
    shutdown_signal().await;
    tracing::info!("Shutting down");
    let _ = std::fs::remove_file(&instance);
    running.stop().await;
    Ok(())
}

/// A sign-in link from a running instance, if one answers with the stored token.
async fn existing_instance(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let instance: Value = serde_json::from_str(&text).ok()?;
    let port = instance["port"].as_u64()?;
    let token = instance["token"].as_str()?;
    let base = format!("http://127.0.0.1:{port}");
    let response = reqwest::Client::new()
        .post(format!("{base}/api/session/link"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    Some(format!("{base}{}", body["path"].as_str()?))
}

fn open_browser(url: &str) {
    let result = if cfg!(windows) {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if result.is_err() {
        println!("Open the link above in your browser.");
    }
}

/// Waits for Ctrl+C or, on Unix, SIGTERM.
async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
}
