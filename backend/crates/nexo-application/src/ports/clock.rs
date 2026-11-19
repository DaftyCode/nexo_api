//! The clock of this computer, for the monitors' schedules.
use nexo_domain::monitor::LocalTime;

/// The time now and the wall-clock time of this computer at any instant, in its own time
/// zone, daylight saving time included.
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now(&self) -> i64;
    /// The minute this computer's clock shows at `millis` (milliseconds since the epoch).
    fn local(&self, millis: i64) -> LocalTime;
}
