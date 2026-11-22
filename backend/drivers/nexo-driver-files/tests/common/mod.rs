//! The driver served over the real protocol, as Nexo's host serves it, on files each test
//! makes: no server is needed, so these tests always run.
#![allow(dead_code)]
use async_trait::async_trait;
use nexo_driver_files::FilesDriver;
use nexo_driver_sdk::{
    Client, DriverError, Handler, Peer, Result, Value,
    protocol::ConnectParams,
    statements::{ExecuteParams, ExecuteResult},
};
use serde_json::Value as Json;
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};

/// A host that answers nothing: the files driver reaches no network, so it never asks.
struct Host;
#[async_trait]
impl Handler for Host {
    async fn request(&self, method: &str, _params: Json) -> Result<Json> {
        Err(DriverError::unsupported(format!(
            "The files driver asked the host for {method}"
        )))
    }
}

pub fn driver() -> Client {
    let (to_driver, from_host) = tokio::io::duplex(1 << 20);
    let (to_host, from_driver) = tokio::io::duplex(1 << 20);
    tokio::spawn(nexo_driver_sdk::serve(
        FilesDriver::default(),
        from_host,
        to_host,
    ));
    let (peer, _) = Peer::start(from_driver, to_driver, |_| Host);
    Client::new(peer)
}

/// A folder of its own for a test, removed when it ends.
pub struct Folder(pub PathBuf);
impl Folder {
    pub fn new(test: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "nexo-files-{test}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    pub fn write(&self, name: &str, text: &str) -> PathBuf {
        let path = self.file(name);
        std::fs::write(&path, text).unwrap();
        path
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A file written by DuckDB itself, for the formats it writes (Parquet, a database).
pub fn duckdb(sql: &str) {
    duckdb::Connection::open_in_memory()
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}

/// A small Excel workbook of one sheet, written by hand: its rows of text or numbers.
pub fn xlsx(path: &Path, rows: &[&[&str]]) {
    let cell = |row: usize, at: usize, value: &str| {
        let place = format!("{}{}", (b'A' + at as u8) as char, row + 1);
        if value.parse::<f64>().is_ok() {
            format!(r#"<c r="{place}" t="n"><v>{value}</v></c>"#)
        } else {
            format!(r#"<c r="{place}" t="inlineStr"><is><t>{value}</t></is></c>"#)
        }
    };
    let sheet_rows: String = rows
        .iter()
        .enumerate()
        .map(|(row, cells)| {
            let cells: String = cells
                .iter()
                .enumerate()
                .map(|(at, value)| cell(row, at, value))
                .collect();
            format!(r#"<row r="{}">{}</row>"#, row + 1, cells)
        })
        .collect();
    let files = [
        ("[Content_Types].xml", r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.to_owned()),
        ("_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_owned()),
        ("xl/workbook.xml", r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stock" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_owned()),
        ("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_owned()),
        ("xl/worksheets/sheet1.xml", format!(r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_rows}</sheetData></worksheet>"#)),
    ];
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, text) in files {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

pub fn params(connection: &str, database: &str, options: &[(&str, &str)]) -> ConnectParams {
    ConnectParams {
        connection: connection.into(),
        database: Some(database.into()),
        options: options
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect::<BTreeMap<_, _>>(),
        ..ConnectParams::default()
    }
}

pub fn statement(connection: &str, sql: &str) -> ExecuteParams {
    ExecuteParams {
        connection: connection.into(),
        statement: format!("s-{sql}"),
        sql: sql.into(),
        params: Vec::new(),
        page_rows: None,
        max_rows: None,
    }
}

pub async fn run(client: &Client, connection: &str, sql: &str) -> Result<ExecuteResult> {
    client.execute(&statement(connection, sql)).await
}

pub async fn single(client: &Client, connection: &str, sql: &str) -> Value {
    run(client, connection, sql).await.unwrap().rows[0][0].clone()
}
