use nexo_server::{Config, Mode, Running, random_token, serve};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

mod sign_in;

#[derive(Clone, Serialize)]
struct DesktopInfo {
    base_url: String,
    token: String,
}
/// Backend status shared with the interface through `desktop_info`.
struct Backend {
    info: Result<DesktopInfo, String>,
    running: Mutex<Option<Running>>,
}
/// Opens the system print dialog for the page, where "Save as PDF" is one of the printers.
/// `window.print()` does nothing in some system webviews (WKWebView on macOS).
#[tauri::command]
fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_info(state: tauri::State<'_, Backend>) -> Result<DesktopInfo, String> {
    state.info.clone()
}

/// Writes logs, including execution engine errors, to the app log directory.
fn start_logging(app: &tauri::App) {
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("nexo.log"))
    else {
        return;
    };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tower_http=warn")),
        )
        .with_ansi(false)
        .with_writer(Mutex::new(file))
        .try_init();
}

fn start_backend(app: &tauri::App) -> Result<(DesktopInfo, Running), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let token = random_token();
    let mut origins = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".into(),
        "https://tauri.localhost".into(),
    ];
    if cfg!(debug_assertions) {
        origins.push("http://localhost:4200".into());
    }
    let config = Config {
        data,
        mode: Mode::Desktop,
        token: token.clone(),
        origins,
        web_root: None,
        master_key: None,
    };
    let running = tauri::async_runtime::block_on(serve(config, "127.0.0.1:0"))
        .map_err(|error| format!("Nexo could not start its local service: {error}"))?;
    Ok((
        DesktopInfo {
            base_url: format!("http://127.0.0.1:{}", running.port),
            token,
        },
        running,
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .setup(|app| {
            start_logging(app);
            let backend = match start_backend(app) {
                Ok((info, running)) => Backend {
                    info: Ok(info),
                    running: Mutex::new(Some(running)),
                },
                Err(error) => {
                    eprintln!("{error}");
                    tracing::error!(%error, "Nexo API could not start its local service");
                    Backend {
                        info: Err(error),
                        running: Mutex::new(None),
                    }
                }
            };
            app.manage(backend);
            app.manage(sign_in::Current::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            print_page,
            sign_in::oauth2_sign_in_window,
            sign_in::oauth2_sign_in_window_close
        ])
        .build(tauri::generate_context!());
    let application = match application {
        Ok(application) => application,
        Err(error) => {
            eprintln!("Unable to start Nexo API: {error}");
            std::process::exit(1);
        }
    };
    application.run(|app, event| {
        if let RunEvent::Exit = event
            && let Some(running) = app
                .state::<Backend>()
                .running
                .lock()
                .ok()
                .and_then(|mut running| running.take())
        {
            tauri::async_runtime::block_on(running.stop());
        }
    });
}
