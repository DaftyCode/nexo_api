pub mod clock;
pub mod git;
pub mod native;
pub mod sqlite;
pub mod user_files;
pub mod vault;
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub fn infrastructure(error: impl std::fmt::Display) -> nexo_domain::Error {
    nexo_domain::Error::Infrastructure(error.to_string())
}
