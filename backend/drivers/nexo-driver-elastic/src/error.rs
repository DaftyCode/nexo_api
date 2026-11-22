//! The errors of the API as the errors of every driver: the engine's `reason`, with a code by
//! its `type` and status.
use crate::http::Answer;
use nexo_driver_sdk::DriverError;

/// The error an answer of status 400 or more carries.
pub(crate) fn answer_error(answer: &Answer) -> DriverError {
    let body: serde_json::Value = serde_json::from_slice(&answer.body).unwrap_or_default();
    let error = &body["error"];
    let reason = error["reason"]
        .as_str()
        .or_else(|| error.as_str())
        .or_else(|| body["message"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            String::from_utf8_lossy(&answer.body)
                .chars()
                .take(500)
                .collect()
        });
    let kind = error["type"].as_str().unwrap_or_default();
    let message = if kind.is_empty() {
        reason
    } else {
        format!("{kind}: {reason}")
    };
    match answer.status {
        401 => DriverError::auth(message),
        403 => DriverError::permission(message),
        408 | 504 => DriverError::timeout(message),
        _ if kind.contains("parsing")
            || kind.contains("verification")
            || kind.contains("syntax") =>
        {
            DriverError::syntax(message)
        }
        _ => DriverError::invalid(message),
    }
}
