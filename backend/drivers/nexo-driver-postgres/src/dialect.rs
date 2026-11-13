//! How PostgreSQL writes SQL, for the editor: its quotes, parameters, keywords, functions and
//! types. A fixed list, as `hello` is answered before any connection.
use nexo_driver_sdk::protocol::{Dialect, ParameterStyle};

const KEYWORDS: &str = "all alter analyze and any array as asc asymmetric begin between by cascade case cast \
    check collate column commit concurrently constraint create cross current_date current_time current_timestamp \
    current_user cursor database declare default deferrable delete desc distinct do drop else end except exists \
    explain extension false fetch filter for foreign from full function grant group having if ilike in index \
    inherits inner insert intersect into is join lateral leading left like limit local materialized natural not \
    notnull null nulls offset on only or order outer over partition placing primary procedure recursive references \
    refresh rename replace returning revoke right role rollback row rows savepoint schema select sequence session_user \
    set similar some symmetric table tablespace temporary then to trailing transaction trigger true truncate type \
    union unique unlogged update user using vacuum values variadic verbose view when where window with";

const FUNCTIONS: &str = "abs array_agg array_length avg coalesce concat count current_setting date_part date_trunc \
    extract format generate_series greatest json_agg json_build_object jsonb_agg jsonb_build_object jsonb_set least \
    length lower ltrim max min now nullif pg_sleep regexp_replace replace round row_number rtrim split_part \
    string_agg substring sum to_char to_date to_timestamp trim upper";

const TYPES: &str = "bigint bigserial bit boolean bytea char character cidr date double float4 float8 inet integer \
    interval json jsonb macaddr money numeric real serial smallint text time timestamp timestamptz tsvector uuid \
    varchar xml";

fn words(list: &str) -> Vec<String> {
    list.split_whitespace().map(String::from).collect()
}

pub(crate) fn dialect() -> Dialect {
    Dialect {
        name: "postgresql".into(),
        quote_open: "\"".into(),
        quote_close: "\"".into(),
        parameters: ParameterStyle::Numbered,
        keywords: words(KEYWORDS),
        functions: words(FUNCTIONS),
        types: words(TYPES),
    }
}
