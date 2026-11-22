//! How DuckDB writes SQL, for the editor: double quotes, `?` parameters, keywords, functions
//! and types. A fixed list, as `hello` is answered before any connection.
use nexo_driver_sdk::protocol::{Dialect, ParameterStyle};

const KEYWORDS: &str = "all and any array as asc between by case cast collate columns cross \
    cube current_date current_time current_timestamp desc describe distinct else end except \
    exclude exists explain false filter from full group grouping having ilike in inner intersect \
    interval is join lateral left like limit natural not null nulls offset on or order outer over \
    partition pivot positional qualify range recursive replace right rollup row rows sample select \
    semi anti asof show some struct summarize table then true union unnest unpivot using values \
    when where window with within";

const FUNCTIONS: &str = "abs any_value approx_count_distinct arg_max arg_min avg bool_and bool_or \
    ceil coalesce concat concat_ws contains count date_diff date_part date_trunc day epoch first \
    floor greatest hash histogram if ifnull last least left length list list_agg lower lpad ltrim \
    max median min mode month now nullif quantile_cont regexp_extract regexp_matches regexp_replace \
    replace right round rpad rtrim split_part starts_with stddev strftime string_agg strptime struct_pack \
    substr substring sum today trim trunc typeof upper year";

const TYPES: &str = "bigint bit blob boolean date decimal double float hugeint integer interval \
    json list map smallint struct time timestamp timestamptz tinyint ubigint uhugeint uinteger union \
    usmallint utinyint uuid varchar";

fn words(list: &str) -> Vec<String> {
    list.split_whitespace().map(str::to_owned).collect()
}

pub(crate) fn dialect() -> Dialect {
    Dialect {
        name: "duckdb".into(),
        quote_open: "\"".into(),
        quote_close: "\"".into(),
        parameters: ParameterStyle::Question,
        keywords: words(KEYWORDS),
        functions: words(FUNCTIONS),
        types: words(TYPES),
    }
}
