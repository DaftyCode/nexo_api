//! The SQLite driver as the process Nexo starts.
#[tokio::main]
async fn main() {
    nexo_driver_sdk::run(nexo_driver_sqlite::SqliteDriver::default()).await
}
