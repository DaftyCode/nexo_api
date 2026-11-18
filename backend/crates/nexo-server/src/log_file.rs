//! A log file that never passes its limit. Past it, the file becomes `<name>.old.log`,
//! replacing the one before, and a new one starts: there are never more than two files, and
//! together they take at most twice the limit.
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Size at which the desktop log starts over; with the previous one kept, 10 MB at most.
pub const LOG_LIMIT: u64 = 5 * 1024 * 1024;

pub struct RotatingLog {
    path: PathBuf,
    old: PathBuf,
    file: Option<File>,
    size: u64,
    limit: u64,
}
impl RotatingLog {
    /// Opens `directory/name` to add to it, starting over first when it is already full.
    pub fn open(directory: &Path, name: &str, limit: u64) -> io::Result<Self> {
        std::fs::create_dir_all(directory)?;
        let path = directory.join(name);
        let size = std::fs::metadata(&path).map_or(0, |metadata| metadata.len());
        let mut log = Self {
            old: path.with_extension("old.log"),
            file: Some(append(&path)?),
            path,
            size,
            limit,
        };
        if log.size >= limit {
            log.rotate()?;
        }
        Ok(log)
    }
    fn rotate(&mut self) -> io::Result<()> {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.old);
        // When another program holds the file and it cannot be renamed, it starts over in place.
        self.file = Some(match std::fs::rename(&self.path, &self.old) {
            Ok(()) => append(&self.path)?,
            Err(_) => File::create(&self.path)?,
        });
        self.size = 0;
        Ok(())
    }
}
fn append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}
impl Write for RotatingLog {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.size > 0 && self.size + buffer.len() as u64 > self.limit {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("The log file is closed"))?;
        let written = file.write(buffer)?;
        self.size += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), Write::flush)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        std::env::temp_dir().join(format!("nexo-log-{}", uuid::Uuid::new_v4()))
    }
    fn files(directory: &Path) -> Vec<(String, u64)> {
        let mut files: Vec<(String, u64)> = std::fs::read_dir(directory)
            .unwrap()
            .flatten()
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                (name, entry.metadata().unwrap().len())
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn a_full_log_starts_over_and_keeps_only_the_one_before() {
        let directory = directory();
        let mut log = RotatingLog::open(&directory, "nexo.log", 100).unwrap();
        for line in 0..40 {
            writeln!(log, "line {line:03} of the log").unwrap();
        }
        // Windows lists the size of an open file late: it is read once the log is closed.
        drop(log);
        let found = files(&directory);
        assert_eq!(
            found
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["nexo.log", "nexo.old.log"]
        );
        assert!(found.iter().all(|(_, size)| *size <= 100), "{found:?}");
        let newest = std::fs::read_to_string(directory.join("nexo.log")).unwrap();
        assert!(newest.ends_with("line 039 of the log\n"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_log_left_full_starts_over_when_it_opens_and_one_with_room_goes_on() {
        let directory = directory();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("nexo.log"), "x".repeat(150)).unwrap();
        std::fs::write(directory.join("nexo.old.log"), "older").unwrap();
        let mut log = RotatingLog::open(&directory, "nexo.log", 100).unwrap();
        log.write_all(b"new\n").unwrap();
        drop(log);
        assert_eq!(
            files(&directory),
            [("nexo.log".into(), 4), ("nexo.old.log".into(), 150)]
        );
        let mut log = RotatingLog::open(&directory, "nexo.log", 100).unwrap();
        log.write_all(b"more\n").unwrap();
        log.flush().unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join("nexo.log")).unwrap(),
            "new\nmore\n"
        );
        assert_eq!(LOG_LIMIT, 5 * 1024 * 1024);
        drop(log);
        let _ = std::fs::remove_dir_all(directory);
    }
}
