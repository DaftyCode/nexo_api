//! A search with a driver's own `execute`: see [`super`].
use super::{SearchCatalog, SearchMode, SearchParams, SearchResult, data, metadata};
use crate::{Driver, DriverError, Result};

/// Searches a connection: its objects, or the data of the tables asked for, table by table.
/// A cancelled table stops the search with what it found so far said as an error.
pub async fn run<D: Driver + ?Sized>(
    driver: &D,
    params: SearchParams,
    catalog: &dyn SearchCatalog,
) -> Result<SearchResult> {
    if params.text.trim().is_empty() {
        return Err(DriverError::invalid("Say what to look for"));
    }
    match params.mode {
        SearchMode::Metadata => metadata::objects(driver, &params, catalog).await,
        SearchMode::Data => {
            let dialect = driver.hello().dialect;
            let mut result = SearchResult::default();
            for table in &params.tables {
                if let Some(hit) = data::table(driver, &params, catalog, &dialect, table).await? {
                    result.data.push(hit);
                }
            }
            Ok(result)
        }
    }
}
