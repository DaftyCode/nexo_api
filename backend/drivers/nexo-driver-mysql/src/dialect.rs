//! How MySQL and MariaDB write SQL, for the editor: backquotes, `?` parameters, keywords,
//! functions and types. A fixed list, as `hello` is answered before any connection.
use nexo_driver_sdk::protocol::{Dialect, ParameterStyle};

const KEYWORDS: &str = "accessible add after algorithm all alter analyze and as asc ascii auto_increment \
    before begin between binary both by call cascade case change character charset check collate column \
    columns comment commit constraint continue convert create cross current_date current_time \
    current_timestamp current_user cursor database databases day declare default definer delayed delete \
    delimiter desc describe deterministic distinct distinctrow div do drop dual duplicate each else elseif \
    enclosed end engine escaped event events exists exit explain false fetch fields first for force foreign \
    from fulltext function generated grant group handler having high_priority if ignore in index infile \
    inner inout insert interval into invoker is iterate join key keys kill language last lateral leading \
    leave left like limit lines load local lock loop low_priority match modifies natural not no_write_to_binlog \
    null offset on optimize option optionally or order out outer outfile over partition prepare primary \
    procedure purge range read reads recursive references regexp release rename repeat replace require \
    restrict return returns revoke right rlike rollback row rows savepoint schema schemas security select \
    separator set show signal spatial sql sql_calc_found_rows sql_big_result sql_small_result sqlexception \
    sqlstate sqlwarning ssl start starting status stored straight_join table tables temporary terminated \
    then to trailing transaction trigger true truncate undo union unique unlock unsigned update usage use \
    using values variables view virtual when where while window with work write xor zerofill";

const FUNCTIONS: &str = "abs avg bin bit_and bit_or bit_xor cast ceil ceiling char_length coalesce concat \
    concat_ws conv convert_tz count curdate curtime date_add date_format date_sub datediff dayname \
    dayofmonth dayofweek dayofyear elt exp extract field find_in_set floor format from_unixtime \
    group_concat greatest hex hour if ifnull inet_aton inet_ntoa insert instr isnull json_array \
    json_contains json_extract json_keys json_length json_object json_set json_table json_unquote \
    json_valid last_day last_insert_id lcase least left length locate lower lpad ltrim max md5 \
    microsecond mid min minute mod month monthname now nullif oct ord period_diff pi position pow power \
    quarter rand regexp_like regexp_replace regexp_substr repeat replace reverse right round row_count \
    rpad rtrim second sha1 sha2 sign sin space sqrt str_to_date strcmp subdate substr substring \
    substring_index sum sysdate time_format time_to_sec timediff timestamp timestampadd timestampdiff \
    to_base64 to_days trim truncate ucase unhex unix_timestamp upper utc_date utc_time utc_timestamp \
    uuid uuid_to_bin version week weekday weekofyear year yearweek";

const TYPES: &str = "bigint binary bit blob bool boolean char date datetime decimal double enum float \
    geometry geometrycollection int integer json linestring longblob longtext mediumblob mediumint \
    mediumtext multilinestring multipoint multipolygon numeric point polygon real set smallint text time \
    timestamp tinyblob tinyint tinytext unsigned varbinary varchar year";

fn words(list: &str) -> Vec<String> {
    list.split_whitespace().map(String::from).collect()
}

pub(crate) fn dialect() -> Dialect {
    Dialect {
        name: "mysql".into(),
        quote_open: "`".into(),
        quote_close: "`".into(),
        parameters: ParameterStyle::Question,
        keywords: words(KEYWORDS),
        functions: words(FUNCTIONS),
        types: words(TYPES),
    }
}

/// A name between backquotes, as MySQL quotes identifiers.
pub(crate) fn quoted(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// A text between single quotes, for the few statements that take no parameters (`SHOW`).
pub(crate) fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_names_and_texts() {
        assert_eq!(quoted("my`table"), "`my``table`");
        assert_eq!(literal(r"it's \ here"), r"'it''s \\ here'");
    }
}
