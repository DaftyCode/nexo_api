//! What a connection opens (DB-30): a DuckDB database file (`.duckdb`), or files as tables:
//! a folder (every CSV, TSV, JSON, Parquet and Excel file in it) or files separated by `;`.
//! Each file becomes a table named after it (`ventas.csv` → `ventas`). The settings of the
//! readers come from a closed list.
use nexo_driver_sdk::{DriverError, Result};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// The settings a connection takes, for the readers of its files.
pub const SETTINGS: [&str; 7] = [
    "delimiter",
    "header",
    "quote",
    "encoding",
    "sheet",
    "json_format",
    "all_varchar",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
    Parquet,
    Excel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataFile {
    pub path: PathBuf,
    pub table: String,
    pub format: Format,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A DuckDB database, with its schemas, tables and views.
    Database(PathBuf),
    /// Files read as tables, never written.
    Files(Vec<DataFile>),
}

/// Files a folder may give at most.
const MAX_FILES: usize = 500;

fn format_of(path: &Path) -> Option<Format> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match extension.as_str() {
        "csv" | "tsv" | "txt" => Some(Format::Csv),
        "json" | "jsonl" | "ndjson" => Some(Format::Json),
        "parquet" => Some(Format::Parquet),
        "xlsx" | "xlsm" | "xls" | "ods" => Some(Format::Excel),
        _ => None,
    }
}

/// A name of a table from its file: letters, digits and `_`, unique among the others.
fn table_name(path: &Path, taken: &[DataFile]) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut name: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
        name.insert(0, 't');
    }
    let base = name.clone();
    let mut number = 2;
    while taken
        .iter()
        .any(|file| file.table.eq_ignore_ascii_case(&name))
    {
        name = format!("{base}_{number}");
        number += 1;
    }
    name
}

fn file(path: PathBuf, files: &[DataFile]) -> Result<DataFile> {
    let format = format_of(&path).ok_or_else(|| {
        DriverError::invalid(format!(
            "{} is not a CSV, JSON, Parquet or Excel file",
            path.display()
        ))
    })?;
    let table = table_name(&path, files);
    Ok(DataFile {
        path,
        table,
        format,
    })
}

/// What `database` names: a `.duckdb` file, a folder, or files separated by `;`.
pub fn target(database: Option<&str>) -> Result<Target> {
    let text = database
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            DriverError::invalid("Write the folder, the files or the DuckDB database to open")
        })?;
    let paths: Vec<PathBuf> = text
        .split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .collect();
    if let [single] = paths.as_slice() {
        let extension = single
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("duckdb" | "ddb")) {
            if !single.is_file() {
                return Err(DriverError::invalid(format!(
                    "{} does not exist",
                    single.display()
                )));
            }
            return Ok(Target::Database(single.clone()));
        }
        if single.is_dir() {
            let mut found: Vec<PathBuf> = std::fs::read_dir(single)
                .map_err(|error| DriverError::invalid(format!("{}: {error}", single.display())))?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.is_file() && format_of(path).is_some())
                .collect();
            found.sort();
            let mut files = Vec::new();
            for path in found.into_iter().take(MAX_FILES) {
                let read = file(path, &files)?;
                files.push(read);
            }
            return Ok(Target::Files(files));
        }
    }
    let mut files = Vec::new();
    for path in paths.into_iter().take(MAX_FILES) {
        if !path.is_file() {
            return Err(DriverError::invalid(format!(
                "{} does not exist",
                path.display()
            )));
        }
        let read = file(path, &files)?;
        files.push(read);
    }
    Ok(Target::Files(files))
}

/// The settings of the readers, from the closed list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Readers {
    pub delimiter: Option<String>,
    pub header: Option<bool>,
    pub quote: Option<String>,
    pub encoding: Option<String>,
    pub sheet: Option<String>,
    pub json_format: Option<String>,
    pub all_varchar: bool,
}

fn flag(name: &str, value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(DriverError::invalid(format!(
            "{name} is true or false, not {value}"
        ))),
    }
}

pub fn readers(options: &BTreeMap<String, String>) -> Result<Readers> {
    let mut found = Readers::default();
    for (name, value) in options {
        let text = value.trim();
        match name.as_str() {
            "delimiter" | "quote" if text.chars().count() != 1 && text != "\\t" => {
                return Err(DriverError::invalid(format!("{name} is one character")));
            }
            "delimiter" => found.delimiter = Some(text.replace("\\t", "\t")),
            "quote" => found.quote = Some(text.to_owned()),
            "header" => found.header = Some(flag(name, text)?),
            "encoding" => {
                let encoding = text.to_ascii_lowercase().replace('_', "-");
                if !["utf-8", "utf-16", "latin-1"].contains(&encoding.as_str()) {
                    return Err(DriverError::invalid("encoding is utf-8, utf-16 or latin-1"));
                }
                found.encoding = Some(encoding);
            }
            "sheet" => found.sheet = Some(text.to_owned()),
            "json_format" => {
                if !["auto", "array", "newline_delimited"].contains(&text) {
                    return Err(DriverError::invalid(
                        "json_format is auto, array or newline_delimited",
                    ));
                }
                found.json_format = Some(text.to_owned());
            }
            "all_varchar" => found.all_varchar = flag(name, text)?,
            other => {
                return Err(DriverError::invalid(format!(
                    "Files do not take the setting {other}: use {}",
                    SETTINGS.join(", ")
                )));
            }
        }
    }
    Ok(found)
}

/// A string as a literal of DuckDB.
pub fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The view of a file: the reader of its format with the connection's settings. Excel
/// workbooks are not views: they are read into a table (`excel.rs`).
pub fn view_sql(file: &DataFile, readers: &Readers) -> String {
    let path = literal(&file.path.to_string_lossy());
    let table = format!("\"{}\"", file.table.replace('"', "\"\""));
    let mut options = Vec::new();
    let reader = match file.format {
        Format::Csv => {
            if let Some(delimiter) = &readers.delimiter {
                options.push(format!("delim = {}", literal(delimiter)));
            } else if file
                .path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("tsv"))
            {
                options.push("delim = '\t'".into());
            }
            if let Some(header) = readers.header {
                options.push(format!("header = {header}"));
            }
            if let Some(quote) = &readers.quote {
                options.push(format!("quote = {}", literal(quote)));
            }
            if let Some(encoding) = &readers.encoding {
                options.push(format!("encoding = {}", literal(encoding)));
            }
            if readers.all_varchar {
                options.push("all_varchar = true".into());
            }
            "read_csv"
        }
        Format::Json => {
            if let Some(format) = &readers.json_format {
                options.push(format!("format = {}", literal(format)));
            }
            "read_json_auto"
        }
        Format::Parquet => "read_parquet",
        Format::Excel => unreachable!("Excel workbooks are read into a table"),
    };
    let options = options
        .iter()
        .map(|option| format!(", {option}"))
        .collect::<String>();
    format!("CREATE VIEW {table} AS SELECT * FROM {reader}({path}{options})")
}
