//! The Ignite driver as the process Nexo starts.
#[tokio::main]
async fn main() {
    nexo_driver_sdk::run(nexo_driver_ignite::IgniteDriver::default()).await
}
