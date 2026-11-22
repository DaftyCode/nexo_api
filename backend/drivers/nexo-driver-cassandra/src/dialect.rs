//! How CQL is written, for the editor: double quotes, `?` markers, its keywords, functions
//! and types. A fixed list, as `hello` is answered before any connection.
use nexo_driver_sdk::protocol::{Dialect, ParameterStyle};

const KEYWORDS: &str = "add aggregate all allow alter and apply as asc ascii authorize batch \
    begin by called clustering columnfamily compact contains create custom delete desc describe \
    distinct drop entries execute exists filtering finalfunc frozen from full function functions \
    grant if in index initcond input insert into is json key keys keyspace keyspaces language \
    like limit list login materialized modify nologin norecursive nosuperuser not null of on \
    options or order partition password per permission permissions primary rename replace \
    returns revoke role roles schema select set sfunc static stype superuser table tables text \
    to token trigger truncate ttl tuple type unlogged unset update use user users using values \
    view where with writetime";

const FUNCTIONS: &str = "avg blobasbigint bigintasblob cast count currentdate currenttime \
    currenttimestamp currenttimeuuid dateof max maxtimeuuid min mintimeuuid now similarity_cosine \
    similarity_dot_product similarity_euclidean sum toDate toTimestamp toUnixTimestamp token ttl \
    unixtimestampof uuid writetime";

const TYPES: &str = "ascii bigint blob boolean counter date decimal double duration float \
    frozen inet int list map set smallint text time timestamp timeuuid tinyint tuple uuid varchar \
    varint vector";

fn words(list: &str) -> Vec<String> {
    list.split_whitespace().map(str::to_owned).collect()
}

pub(crate) fn dialect() -> Dialect {
    Dialect {
        name: "cql".into(),
        quote_open: "\"".into(),
        quote_close: "\"".into(),
        parameters: ParameterStyle::Question,
        keywords: words(KEYWORDS),
        functions: words(FUNCTIONS),
        types: words(TYPES),
    }
}
