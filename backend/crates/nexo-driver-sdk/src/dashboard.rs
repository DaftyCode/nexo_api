//! The dashboards of a server (`dashboards`): the panels a driver offers, each one a query
//! read again every few seconds and drawn as a chart. The driver only describes them; the
//! interface reads each query through the host, as one more read of a session.
//!
//! A query answers one row, a series per numeric column named after it, or several rows, a
//! series per row: its first column the label and its second the value.
use serde::{Deserialize, Serialize};

/// How a panel is drawn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartKind {
    #[default]
    Line,
    Area,
    Bar,
    /// The last value, large.
    Value,
}

/// Seconds between two readings when a panel does not say.
pub const INTERVAL: u32 = 5;

/// A panel of a dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    /// Stable among the driver's panels, to keep where the person put it.
    pub id: String,
    pub title: String,
    /// A read; never anything that changes the server.
    pub sql: String,
    pub chart: ChartKind,
    /// What the values are: `sessions`, `bytes`, `rows`… With `delta`, per second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// The values are counters that only grow: each point is the change per second since
    /// the reading before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub delta: bool,
    /// Seconds between readings, at least 1.
    pub interval: u32,
}

impl Dashboard {
    /// A panel read every [`INTERVAL`] seconds.
    pub fn new(id: &str, title: &str, chart: ChartKind, sql: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            sql: sql.into(),
            chart,
            unit: None,
            delta: false,
            interval: INTERVAL,
        }
    }
    pub fn unit(mut self, unit: &str) -> Self {
        self.unit = Some(unit.into());
        self
    }
    /// Its values are counters, drawn per second.
    pub fn per_second(mut self) -> Self {
        self.delta = true;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardParams {
    pub connection: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Dashboards {
    pub dashboards: Vec<Dashboard>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panel_travels_with_its_chart_unit_and_kind_of_values() {
        let panel = Dashboard::new("tps", "Transactions", ChartKind::Area, "SELECT 1")
            .unit("transactions")
            .per_second();
        let json = serde_json::to_value(&panel).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "tps", "title": "Transactions", "sql": "SELECT 1",
                "chart": "area", "unit": "transactions", "delta": true, "interval": 5})
        );
        let plain = serde_json::to_value(Dashboard::new("s", "S", ChartKind::Value, "x")).unwrap();
        assert!(plain.get("unit").is_none() && plain.get("delta").is_none());
    }
}
