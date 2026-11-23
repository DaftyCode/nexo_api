use super::*;
use crate::values::{INT32, STRING};

fn column(writer: &mut Writer, name: &str, type_id: i64, origin: Option<(&str, &str)>) {
    writer
        .int(if origin.is_some() { 9 } else { 6 })
        .str(name)
        .bool(true);
    writer.int(type_id).int(0).int(10);
    match origin {
        Some((schema, table)) => {
            writer.bool(true).nil();
            if schema.is_empty() {
                // The index of the first column, which has the same schema and table.
                writer.int(0).int(0);
            } else {
                writer.str(schema).str(table);
            }
        }
        None => {
            writer.bool(false);
        }
    }
}

fn row(writer: &mut Writer, id: i64, name: &str) {
    let mut tuple = Builder::default();
    tuple.int(id).varlen(name.as_bytes());
    writer.bin(&tuple.build());
}

#[test]
fn an_answer_has_its_columns_rows_and_cursor() {
    let mut writer = Writer::default();
    writer
        .int(7)
        .bool(true)
        .bool(true)
        .bool(false)
        .int(-1)
        .int(2);
    column(&mut writer, "ID", INT32, Some(("PUBLIC", "ITEMS")));
    column(&mut writer, "NAME", STRING, Some(("", "")));
    writer.int(2);
    row(&mut writer, 1, "a");
    row(&mut writer, 2, "b");
    let answer = answer(&writer.into_bytes()).unwrap();
    assert_eq!(answer.cursor, Some(7));
    assert!(answer.has_rows);
    assert_eq!(answer.rows.len(), 2);
    assert_eq!(answer.rows[1][1], Value::Text("b".into()));
    let origin = answer.fields[1].origin.clone().unwrap();
    assert_eq!(origin, ("PUBLIC".into(), "ITEMS".into(), "NAME".into()));
    assert_eq!(answer.fields[0].column().type_name, "INTEGER");
}

#[test]
fn a_write_answers_what_it_changed_without_rows() {
    let mut writer = Writer::default();
    writer
        .nil()
        .bool(false)
        .bool(false)
        .bool(false)
        .int(3)
        .int(0);
    let answer = answer(&writer.into_bytes()).unwrap();
    assert_eq!(answer.affected, 3);
    assert!(!answer.has_rows && answer.cursor.is_none() && answer.fields.is_empty());
    // A last page: the server closes its cursor, so none is kept.
    let mut writer = Writer::default();
    writer
        .int(4)
        .bool(true)
        .bool(false)
        .bool(false)
        .int(-1)
        .int(1);
    column(&mut writer, "N", INT32, None);
    writer.int(0);
    assert_eq!(answer_of(writer).cursor, None);
}

fn answer_of(writer: Writer) -> Answer {
    answer(&writer.into_bytes()).unwrap()
}

#[test]
fn columns_with_more_properties_than_known_are_read() {
    let mut writer = Writer::default();
    writer
        .nil()
        .bool(true)
        .bool(false)
        .bool(false)
        .int(-1)
        .int(1);
    writer
        .int(8)
        .str("X")
        .bool(false)
        .int(INT32)
        .int(0)
        .int(0)
        .bool(false);
    writer.str("future").int(1);
    let mut tuple = Builder::default();
    tuple.int(5);
    writer.int(1).bin(&tuple.build());
    let read = answer_of(writer);
    assert_eq!(read.fields[0].name, "X");
    assert_eq!(read.rows[0][0], Value::Integer(5));
}

#[test]
fn a_statement_is_written_as_the_java_client_writes_it() {
    let args = [Value::Integer(1)];
    let statement = Statement {
        sql: "SELECT ?",
        args: &args,
        schema: Some("SHOP"),
        page: 50,
        timeout_ms: 60_000,
        time_zone: "UTC",
        transaction: Some(9),
    };
    let mut writer = Writer::default();
    write(&mut writer, &statement).unwrap();
    let bytes = writer.into_bytes();
    let mut reader = Reader::new(&bytes);
    assert_eq!(reader.int().unwrap(), 9, "the transaction");
    assert_eq!(reader.str().unwrap(), "SHOP");
    assert_eq!(reader.int().unwrap(), 50);
    assert_eq!(reader.int().unwrap(), 60_000);
    assert!(reader.nil().unwrap(), "the session's idle time");
    assert_eq!(reader.str().unwrap(), "UTC");
    assert_eq!(reader.int().unwrap(), 0, "no properties");
    assert_eq!(reader.bin().unwrap(), [0]);
    assert_eq!(reader.str().unwrap(), "SELECT ?");
    assert_eq!(reader.int().unwrap(), 1, "one argument");
    assert_eq!(reader.bin().unwrap().len(), 7);
    let bare = Statement {
        args: &[],
        schema: None,
        transaction: None,
        ..statement
    };
    let mut writer = Writer::default();
    write(&mut writer, &bare).unwrap();
    let bytes = writer.into_bytes();
    assert_eq!(
        &bytes[..2],
        [0xc0, 0xc0],
        "no transaction, the default schema"
    );
    assert_eq!(bytes.last(), Some(&0xc0), "no arguments");
}
