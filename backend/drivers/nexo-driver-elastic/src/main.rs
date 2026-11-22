//! The Elasticsearch and OpenSearch driver as the process Nexo starts.
#[tokio::main]
async fn main() {
    nexo_driver_sdk::run(nexo_driver_elastic::ElasticDriver::default()).await
}
