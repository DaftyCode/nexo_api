//! How many cookies a jar keeps, about what a browser keeps (RFC 6265, section 5.3), so a
//! server that keeps setting new ones never fills the disk. A jar does not know when a cookie
//! arrived, so the expired ones go first, then those that expire soonest; session cookies,
//! often the sign-in of an API, go last.
use cookie_store::{Cookie, CookieExpiration, CookieStore};
use std::collections::HashMap;

/// Cookies kept for one domain, as Chrome keeps.
pub(super) const PER_DOMAIN: usize = 180;
/// Cookies kept in one jar.
pub(super) const IN_ALL: usize = 3000;

/// Removes the expired cookies and those beyond the limits; returns how many went.
pub(super) fn apply(store: &mut CookieStore) -> usize {
    within(store, PER_DOMAIN, IN_ALL)
}

/// Which cookie goes first: expired, then persistent by expiry, then session cookies.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Order {
    alive: bool,
    session: bool,
    expires: i64,
    domain: String,
    path: String,
    name: String,
}
impl Order {
    fn of(cookie: &Cookie<'_>) -> Self {
        let (session, expires) = match &cookie.expires {
            CookieExpiration::AtUtc(at) => (false, at.unix_timestamp()),
            CookieExpiration::SessionEnd => (true, i64::MAX),
        };
        Self {
            alive: !cookie.is_expired(),
            session,
            expires,
            domain: String::from(&cookie.domain),
            path: String::from(&cookie.path),
            name: cookie.name().to_string(),
        }
    }
}

pub(super) fn within(store: &mut CookieStore, per_domain: usize, in_all: usize) -> usize {
    let mut cookies: Vec<Order> = store.iter_any().map(Order::of).collect();
    cookies.sort();
    let mut gone: Vec<bool> = cookies.iter().map(|cookie| !cookie.alive).collect();
    let mut by_domain: HashMap<&str, usize> = HashMap::new();
    for cookie in cookies.iter().filter(|cookie| cookie.alive) {
        *by_domain.entry(&cookie.domain).or_default() += 1;
    }
    for (index, cookie) in cookies.iter().enumerate() {
        let count = by_domain.entry(&cookie.domain).or_default();
        if !gone[index] && *count > per_domain {
            gone[index] = true;
            *count -= 1;
        }
    }
    let mut left = gone.iter().filter(|gone| !**gone).count();
    for flag in gone.iter_mut().filter(|gone| !**gone) {
        if left <= in_all {
            break;
        }
        *flag = true;
        left -= 1;
    }
    let mut removed = 0;
    for (cookie, _) in cookies.iter().zip(&gone).filter(|(_, gone)| **gone) {
        if store
            .remove(&cookie.domain, &cookie.path, &cookie.name)
            .is_some()
        {
            removed += 1;
        }
    }
    removed
}
