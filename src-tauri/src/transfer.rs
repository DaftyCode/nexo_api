//! Files of MongoDB imports and exports, chosen by the person in a native dialog. The
//! interface gets a handle, never the path, and reads or writes that file in chunks: nothing
//! else of the file system is reachable, and the local service never sees a path.
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::ipc::Response;

/// Files open at once, at most.
const MAX_OPEN: usize = 8;
/// Bytes read at once, at most.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

enum Opened {
    Read(File),
    Write { file: File, path: PathBuf },
}

/// The files chosen in the dialogs and still open, by handle.
#[derive(Default)]
pub struct Files(Mutex<HashMap<String, Opened>>);

/// A file chosen in a dialog: its handle, the name shown, and its size when read.
#[derive(Debug, Serialize)]
pub struct Chosen {
    handle: String,
    name: String,
    size: u64,
}

impl Files {
    fn add(&self, opened: Opened) -> Result<String, String> {
        let mut files = self.0.lock().map_err(|_| "The files are not available")?;
        if files.len() >= MAX_OPEN {
            return Err("Too many files are open; finish an import or export first".into());
        }
        let handle = uuid::Uuid::new_v4().to_string();
        files.insert(handle.clone(), opened);
        Ok(handle)
    }
    fn read(&self, handle: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let mut files = self.0.lock().map_err(|_| "The files are not available")?;
        let Some(Opened::Read(file)) = files.get_mut(handle) else {
            return Err("The file is not open".into());
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(length.min(MAX_CHUNK))
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }
    fn write(&self, handle: &str, text: &str) -> Result<(), String> {
        let mut files = self.0.lock().map_err(|_| "The files are not available")?;
        let Some(Opened::Write { file, .. }) = files.get_mut(handle) else {
            return Err("The file is not open".into());
        };
        file.write_all(text.as_bytes())
            .map_err(|error| error.to_string())
    }
    /// Closes a file; `discard` deletes a file being written, such as a cancelled export.
    fn close(&self, handle: &str, discard: bool) -> Result<(), String> {
        let removed = self
            .0
            .lock()
            .map_err(|_| "The files are not available")?
            .remove(handle);
        match removed {
            Some(Opened::Write { file, path }) => {
                file.sync_all().map_err(|error| error.to_string())?;
                drop(file);
                if discard {
                    std::fs::remove_file(path).map_err(|error| error.to_string())?;
                }
                Ok(())
            }
            Some(Opened::Read(_)) | None => Ok(()),
        }
    }
}

fn name_of(path: &std::path::Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Asks for a file to import, among `extensions`; `None` when the person cancels.
#[tauri::command]
pub async fn transfer_open(
    window: tauri::Window,
    files: tauri::State<'_, Files>,
    extensions: Vec<String>,
) -> Result<Option<Chosen>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_parent(&window);
    if !extensions.is_empty() {
        dialog = dialog.add_filter("Data", &extensions);
    }
    let Some(picked) = dialog.pick_file().await else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    let file = File::open(&path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let handle = files.add(Opened::Read(file))?;
    Ok(Some(Chosen {
        handle,
        name: name_of(&path),
        size,
    }))
}

/// Bytes of a file opened to import, from `offset`.
#[tauri::command]
pub fn transfer_read(
    files: tauri::State<'_, Files>,
    handle: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    Ok(Response::new(files.read(&handle, offset, length)?))
}

/// Asks where to save an export, suggesting `name`; `None` when the person cancels.
#[tauri::command]
pub async fn transfer_save(
    window: tauri::Window,
    files: tauri::State<'_, Files>,
    name: String,
    extension: String,
) -> Result<Option<Chosen>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_file_name(&name)
        .add_filter(&extension, &[&extension])
        .save_file()
        .await;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    let file = File::create(&path).map_err(|error| error.to_string())?;
    let handle = files.add(Opened::Write {
        file,
        path: path.clone(),
    })?;
    Ok(Some(Chosen {
        handle,
        name: name_of(&path),
        size: 0,
    }))
}

/// Appends text to a file opened to export.
#[tauri::command]
pub fn transfer_write(
    files: tauri::State<'_, Files>,
    handle: String,
    text: String,
) -> Result<(), String> {
    files.write(&handle, &text)
}

#[tauri::command]
pub fn transfer_close(
    files: tauri::State<'_, Files>,
    handle: String,
    discard: bool,
) -> Result<(), String> {
    files.close(&handle, discard)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nexo-transfer-{}-{name}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn only_the_chosen_files_are_read_and_written_by_handle() {
        let files = Files::default();
        let path = temporary("export.json");
        let handle = files
            .add(Opened::Write {
                file: File::create(&path).unwrap(),
                path: path.clone(),
            })
            .unwrap();
        files.write(&handle, "[{\"a\":1},").unwrap();
        files.write(&handle, "{\"b\":2}]").unwrap();
        assert!(
            files.read(&handle, 0, 10).is_err(),
            "a file to write is not read"
        );
        files.close(&handle, false).unwrap();
        assert!(
            files.write(&handle, "x").is_err(),
            "a closed handle writes nothing"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[{\"a\":1},{\"b\":2}]"
        );

        let read = files.add(Opened::Read(File::open(&path).unwrap())).unwrap();
        assert_eq!(files.read(&read, 2, 5).unwrap(), b"\"a\":1");
        assert_eq!(files.read(&read, 100, 5).unwrap(), b"");
        assert!(files.read("other", 0, 5).is_err());
        assert!(
            files.write(&read, "x").is_err(),
            "a file to read is not written"
        );
        files.close(&read, false).unwrap();
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_cancelled_export_leaves_no_file_and_few_files_are_open() {
        let files = Files::default();
        let path = temporary("cancelled.csv");
        let handle = files
            .add(Opened::Write {
                file: File::create(&path).unwrap(),
                path: path.clone(),
            })
            .unwrap();
        files.write(&handle, "a,b\n").unwrap();
        files.close(&handle, true).unwrap();
        assert!(!path.exists());

        let source = temporary("source.txt");
        std::fs::write(&source, "x").unwrap();
        let handles: Vec<String> = (0..MAX_OPEN)
            .map(|_| {
                files
                    .add(Opened::Read(File::open(&source).unwrap()))
                    .unwrap()
            })
            .collect();
        assert!(
            files
                .add(Opened::Read(File::open(&source).unwrap()))
                .is_err()
        );
        for handle in handles {
            files.close(&handle, false).unwrap();
        }
        std::fs::remove_file(source).unwrap();
    }
}
