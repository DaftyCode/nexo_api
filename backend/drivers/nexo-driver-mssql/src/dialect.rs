//! How SQL Server writes SQL (T-SQL), for the editor: brackets, `@P1` parameters, keywords,
//! functions and types. A fixed list, as `hello` is answered before any connection.
use nexo_driver_sdk::protocol::{Dialect, ParameterStyle};

const KEYWORDS: &str = "add all alter and any as asc authorization backup begin between break browse bulk by \
    cascade case check checkpoint close clustered coalesce collate column commit compute constraint contains \
    continue convert create cross current current_date current_time current_timestamp current_user cursor \
    database dbcc deallocate declare default delete deny desc distinct distributed double drop else end errlvl \
    escape except exec execute exists exit external fetch file fillfactor for foreign freetext from full function \
    goto grant group having holdlock identity identity_insert if in index inner insert intersect into is join key \
    kill left like lineno merge national nocheck nonclustered not null nullif of off offsets on open option or \
    order outer over percent pivot plan primary print proc procedure public raiserror read readtext reconfigure \
    references replication restore restrict return revert revoke right rollback rowcount rowguidcol rule save \
    schema select session_user set setuser shutdown some statistics system_user table tablesample textsize then \
    to top tran transaction trigger truncate try_convert tsequal union unique unpivot update updatetext use user \
    values varying view waitfor when where while with within writetext go output offset fetch next rows only";

const FUNCTIONS: &str = "abs avg cast ceiling charindex coalesce concat concat_ws convert count count_big \
    datalength dateadd datediff datefromparts datename datepart day eomonth format getdate getutcdate isnull \
    isjson json_query json_value left len lower ltrim max min month newid nullif object_id object_name quotename \
    replace replicate reverse right round row_number rtrim scope_identity string_agg string_split stuff substring \
    sum sysdatetime sysdatetimeoffset trim try_cast try_convert upper year";

const TYPES: &str = "bigint binary bit char date datetime datetime2 datetimeoffset decimal float geography \
    geometry hierarchyid image int money nchar ntext numeric nvarchar real rowversion smalldatetime smallint \
    smallmoney sql_variant sysname text time tinyint uniqueidentifier varbinary varchar xml";

fn words(list: &str) -> Vec<String> {
    list.split_whitespace().map(String::from).collect()
}

pub(crate) fn dialect() -> Dialect {
    Dialect {
        name: "tsql".into(),
        quote_open: "[".into(),
        quote_close: "]".into(),
        parameters: ParameterStyle::Named,
        keywords: words(KEYWORDS),
        functions: words(FUNCTIONS),
        types: words(TYPES),
    }
}

/// A name between brackets, as `QUOTENAME` writes it.
pub(crate) fn quoted(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}
