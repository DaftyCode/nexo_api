//! The secrets given to a driver, to keep them out of its log lines and its errors.
use nexo_driver_sdk::DriverError;
use serde_json::Value;
use std::sync::Mutex;

const MASK: &str = "[REDACTED]";
/// Shorter values would hide ordinary words; the engine keeps the same floor.
const SHORTEST: usize = 4;

#[derive(Default)]
pub(crate) struct Secrets(Mutex<Vec<String>>);
impl Secrets {
    pub fn add(&self, secret: Option<&str>) {
        let Some(secret) = secret.filter(|secret| secret.len() >= SHORTEST) else {
            return;
        };
        let mut secrets = self.0.lock().unwrap();
        if !secrets.iter().any(|known| known == secret) {
            secrets.push(secret.to_owned());
            // Longest first, so a secret that contains another is masked whole.
            secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        }
    }
    pub fn text(&self, text: &str) -> String {
        let secrets = self.0.lock().unwrap();
        let mut text = text.to_owned();
        for secret in secrets.iter() {
            if text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), MASK);
            }
        }
        text
    }
    fn value(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(&text)),
            Value::Array(items) => items.into_iter().map(|item| self.value(item)).collect(),
            Value::Object(fields) => fields
                .into_iter()
                .map(|(name, value)| (name, self.value(value)))
                .collect(),
            other => other,
        }
    }
    pub fn error(&self, mut error: DriverError) -> DriverError {
        error.message = self.text(&error.message);
        error.detail = error.detail.map(|detail| self.value(detail));
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn masks_secrets_in_text_and_in_error_details() {
        let secrets = Secrets::default();
        secrets.add(Some("hunter2"));
        secrets.add(Some("hunter2-long"));
        secrets.add(Some("abc"));
        secrets.add(None);
        assert_eq!(
            secrets.text("password hunter2-long, then hunter2 and abc"),
            "password [REDACTED], then [REDACTED] and abc"
        );
        let error = DriverError::auth("no hunter2 here")
            .with_detail(json!({"sent": ["hunter2", 5], "user": "ana"}));
        let error = secrets.error(error);
        assert_eq!(error.message, "no [REDACTED] here");
        assert_eq!(
            error.detail,
            Some(json!({"sent": ["[REDACTED]", 5], "user": "ana"}))
        );
    }
}
