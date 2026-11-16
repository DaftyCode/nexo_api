//! The class and the name of a column's type, from what the server says of it.
use mysql_async::{
    Column as MyColumn,
    consts::{ColumnFlags, ColumnType},
};
use nexo_driver_sdk::ValueKind;

/// The character set of binary strings: their bytes are not text.
const BINARY: u16 = 63;

pub(super) fn binary(column: &MyColumn) -> bool {
    column.character_set() == BINARY
}

/// The class of value a column holds.
pub(crate) fn kind_of(column: &MyColumn) -> ValueKind {
    use ColumnType::*;
    let flags = column.flags();
    if flags.intersects(ColumnFlags::ENUM_FLAG | ColumnFlags::SET_FLAG) {
        return ValueKind::Text;
    }
    match column.column_type() {
        MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_INT24
        | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_YEAR => ValueKind::Integer,
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => ValueKind::Decimal,
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => ValueKind::Float,
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => ValueKind::Date,
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => ValueKind::Time,
        MYSQL_TYPE_DATETIME
        | MYSQL_TYPE_DATETIME2
        | MYSQL_TYPE_TIMESTAMP
        | MYSQL_TYPE_TIMESTAMP2 => ValueKind::Timestamp,
        MYSQL_TYPE_JSON => ValueKind::Json,
        // A single bit is a flag, as DBeaver shows it.
        MYSQL_TYPE_BIT if column.column_length() == 1 => ValueKind::Boolean,
        MYSQL_TYPE_BIT => ValueKind::Integer,
        MYSQL_TYPE_GEOMETRY => ValueKind::Spatial,
        MYSQL_TYPE_ENUM | MYSQL_TYPE_SET => ValueKind::Text,
        MYSQL_TYPE_STRING
        | MYSQL_TYPE_VAR_STRING
        | MYSQL_TYPE_VARCHAR
        | MYSQL_TYPE_TINY_BLOB
        | MYSQL_TYPE_MEDIUM_BLOB
        | MYSQL_TYPE_LONG_BLOB
        | MYSQL_TYPE_BLOB => {
            if binary(column) {
                ValueKind::Binary
            } else {
                ValueKind::Text
            }
        }
        MYSQL_TYPE_NULL => ValueKind::Text,
        _ => ValueKind::Other,
    }
}

/// The name of a column's type, as MySQL writes it.
pub(crate) fn type_name(column: &MyColumn) -> String {
    use ColumnType::*;
    let flags = column.flags();
    if flags.contains(ColumnFlags::ENUM_FLAG) {
        return "enum".into();
    }
    if flags.contains(ColumnFlags::SET_FLAG) {
        return "set".into();
    }
    let bytes = binary(column);
    let name = match column.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_STRING if bytes => "binary",
        MYSQL_TYPE_STRING => "char",
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR if bytes => "varbinary",
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => "varchar",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB
            if bytes =>
        {
            "blob"
        }
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            "text"
        }
        MYSQL_TYPE_VECTOR => "vector",
        MYSQL_TYPE_NULL => "null",
        _ => "unknown",
    };
    let unsigned = flags.contains(ColumnFlags::UNSIGNED_FLAG)
        && matches!(
            column.column_type(),
            MYSQL_TYPE_TINY
                | MYSQL_TYPE_SHORT
                | MYSQL_TYPE_INT24
                | MYSQL_TYPE_LONG
                | MYSQL_TYPE_LONGLONG
                | MYSQL_TYPE_DECIMAL
                | MYSQL_TYPE_NEWDECIMAL
                | MYSQL_TYPE_FLOAT
                | MYSQL_TYPE_DOUBLE
        );
    if unsigned {
        format!("{name} unsigned")
    } else {
        name.into()
    }
}
