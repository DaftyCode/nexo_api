//! The test driver as a process, as the host starts any driver.
#[tokio::main]
async fn main() {
    nexo_driver_sdk::run(nexo_driver_test::TestDriver::default()).await
}
