//! The file of a SQLite connection, chosen by the person in a native dialog. Unlike the
//! files of transfers, its path is the answer: the connection keeps it, and the SQLite driver
//! opens only that file (never one of Nexo's own data, which its host refuses).

/// The kinds of file a SQLite database usually has.
const EXTENSIONS: [&str; 4] = ["db", "sqlite", "sqlite3", "db3"];

/// Asks for a database file to open, or (`create`) where to make a new one; `None` when the
/// person cancels.
#[tauri::command]
pub async fn db_file_choose(window: tauri::Window, create: bool) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .add_filter("SQLite", &EXTENSIONS);
    let picked = if create {
        dialog.set_file_name("database.db").save_file().await
    } else {
        dialog.pick_file().await
    };
    Ok(picked.map(|file| file.path().display().to_string()))
}
