//! The files and folders of the local client tools (DB-23), chosen by the person in native
//! dialogs: the folder of the tools, where a backup goes and the backup or script read. The
//! path is the answer; the backend refuses those inside Nexo's own data.

/// The kinds of file a backup or a script usually has.
const BACKUPS: [&str; 5] = ["sql", "dump", "backup", "tar", "gz"];

/// `purpose`: `folder` (a folder: the tools, or a backup in the directory format), `save`
/// (where a backup goes, with `name` proposed) or `open` (a backup or script to read).
/// `None` when the person cancels.
#[tauri::command]
pub async fn native_choose(
    window: tauri::Window,
    purpose: String,
    name: Option<String>,
) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new().set_parent(&window);
    let picked = match purpose.as_str() {
        "folder" => dialog.pick_folder().await,
        "save" => {
            dialog
                .add_filter("Backup", &BACKUPS)
                .set_file_name(name.unwrap_or_else(|| "backup.sql".into()))
                .save_file()
                .await
        }
        "open" => {
            dialog
                .add_filter("Backup or script", &BACKUPS)
                .pick_file()
                .await
        }
        _ => return Err("Unknown dialog".into()),
    };
    Ok(picked.map(|file| file.path().display().to_string()))
}
