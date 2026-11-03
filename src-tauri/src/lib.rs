use nexo_server::{Config, serve};
use serde::Serialize;
use tauri::Manager;
#[derive(Clone, Serialize)]
struct DesktopInfo {
    base_url: String,
    token: String,
}
#[tauri::command]
fn desktop_info(state: tauri::State<'_, DesktopInfo>) -> DesktopInfo {
    state.inner().clone()
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let resources = app.path().resource_dir()?;
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let executable = std::env::current_exe()?;
            let bundled_node = executable
                .parent()
                .unwrap_or(&resources)
                .join(if cfg!(windows) {
                    "nexo-node.exe"
                } else {
                    "nexo-node"
                });
            let node = std::env::var_os("NEXO_NODE")
                .map(Into::into)
                .unwrap_or_else(|| {
                    if bundled_node.exists() {
                        bundled_node
                    } else {
                        "node".into()
                    }
                });
            let engine = if cfg!(debug_assertions) {
                std::env::current_dir()?.join("engine/dist/engine.mjs")
            } else {
                resources.join("runtime/engine.mjs")
            };
            let config = Config {
                data,
                node,
                engine,
                mode: "desktop".into(),
                token: Some(token.clone()),
                allow_signup: false,
                origins: vec![
                    "tauri://localhost".into(),
                    "http://tauri.localhost".into(),
                    "https://tauri.localhost".into(),
                    "http://localhost:4200".into(),
                ],
            };
            let port = tauri::async_runtime::block_on(serve(config, "127.0.0.1:0"))?;
            app.manage(DesktopInfo {
                base_url: format!("http://127.0.0.1:{port}"),
                token,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_info])
        .run(tauri::generate_context!())
        .expect("Unable to start Nexo API");
}
