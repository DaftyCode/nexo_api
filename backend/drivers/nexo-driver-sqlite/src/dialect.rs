//! How SQLite writes SQL, for the editor: double quotes, `?` parameters, keywords, functions
//! and types. A fixed list, as `hello` is answered before any connection.
use nexo_driver_sdk::protocol::{Dialect, ParameterStyle};

const KEYWORDS: &str = "abort action add after all alter always analyze and as asc attach \
    autoincrement before begin between by cascade case cast check collate column commit conflict \
    constraint create cross current current_date current_time current_timestamp database default \
    deferrable deferred delete desc detach distinct do drop each else end escape except exclude \
    exclusive exists explain fail filter first following for foreign from full generated glob group \
    groups having if ignore immediate in index indexed initially inner insert instead intersect into \
    is isnull join key last left like limit match materialized natural no not nothing notnull null \
    nulls of offset on or order others outer over partition plan pragma preceding primary query raise \
    range recursive references regexp reindex release rename replace restrict returning right rollback \
    row rows savepoint select set strict table temp temporary then ties to transaction trigger unbounded \
    union unique update using vacuum values view virtual when where window with without";

const FUNCTIONS: &str = "abs avg changes char coalesce concat concat_ws count date datetime \
    format glob group_concat hex ifnull iif instr json json_array json_each json_extract json_group_array \
    json_group_object json_insert json_object json_patch json_remove json_replace json_set json_tree \
    json_type json_valid julianday last_insert_rowid length like likelihood lower ltrim max min nullif \
    octet_length printf quote random randomblob replace round rtrim sign soundex sqlite_version strftime \
    string_agg substr substring sum time timediff total total_changes trim typeof unhex unicode unixepoch \
    upper zeroblob";

const TYPES: &str = "any blob boolean char date datetime decimal double float int integer numeric real \
    text timestamp varchar";

fn words(list: &str) -> Vec<String> {
    list.split_whitespace().map(str::to_owned).collect()
}

pub(crate) fn dialect() -> Dialect {
    Dialect {
        name: "sqlite".into(),
        quote_open: "\"".into(),
        quote_close: "\"".into(),
        parameters: ParameterStyle::Question,
        keywords: words(KEYWORDS),
        functions: words(FUNCTIONS),
        types: words(TYPES),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_sqlite() {
        let dialect = dialect();
        assert_eq!(
            (dialect.quote_open.as_str(), dialect.quote_close.as_str()),
            ("\"", "\"")
        );
        assert!(dialect.keywords.contains(&"pragma".to_owned()));
    }
}
