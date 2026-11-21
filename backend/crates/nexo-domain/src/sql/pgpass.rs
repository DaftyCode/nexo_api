//! The password file of PostgreSQL's clients (`~/.pgpass`, `%APPDATA%\postgresql\pgpass.conf`),
//! read as libpq reads it: each line is `hostname:port:database:username:password`, any of
//! the first four may be `*`, `\` escapes a `:` or a `\`, and the first line that matches
//! wins. Lines starting with `#` are comments.

/// The fields of a line, unescaped; `None` when it is not a line of five fields.
fn fields(line: &str) -> Option<Vec<String>> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => fields.last_mut()?.push(chars.next().unwrap_or('\\')),
            ':' if fields.len() < 5 => fields.push(String::new()),
            other => fields.last_mut()?.push(other),
        }
    }
    (fields.len() == 5).then_some(fields)
}

/// The password the file gives a connection to `host:port`, its `database` as `user`.
pub fn pgpass_password(
    text: &str,
    host: &str,
    port: u16,
    database: &str,
    user: &str,
) -> Option<String> {
    let port = port.to_string();
    text.lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim_start().starts_with('#') && !line.trim().is_empty())
        .filter_map(fields)
        .find(|fields| {
            let matches = |field: &str, value: &str| field == "*" || field == value;
            matches(&fields[0], host)
                && matches(&fields[1], &port)
                && matches(&fields[2], database)
                && matches(&fields[3], user)
        })
        .map(|fields| fields[4].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_line_that_matches_gives_the_password() {
        let text = "\
# comments and blank lines are skipped

db.example.com:5432:shop:ana:first
db.example.com:*:*:ana:second
*:*:*:*:any\\:with\\\\escapes
broken line
";
        let find = |host, port, database, user| pgpass_password(text, host, port, database, user);
        assert_eq!(
            find("db.example.com", 5432, "shop", "ana").as_deref(),
            Some("first")
        );
        assert_eq!(
            find("db.example.com", 6543, "other", "ana").as_deref(),
            Some("second")
        );
        assert_eq!(
            find("elsewhere", 5432, "shop", "bob").as_deref(),
            Some("any:with\\escapes")
        );
        assert_eq!(
            pgpass_password("h:5432:d:u:pw\r\n", "h", 5432, "d", "u").as_deref(),
            Some("pw")
        );
        assert_eq!(pgpass_password("h:5432:d:u:pw", "h", 5432, "d", "x"), None);
        assert_eq!(pgpass_password("h:5432:d", "h", 5432, "d", "u"), None);
    }
}
