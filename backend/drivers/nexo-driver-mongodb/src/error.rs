//! The errors of the driver: a message for the person, what went wrong and what to check,
//! as Nexo showed them when MongoDB was built in. Each reaches the host as `invalid`, except
//! a failure of this computer, which is `internal`.
use nexo_driver_sdk::DriverError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Validation(String),
    Infrastructure(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(message) | Self::Infrastructure(message) => {
                formatter.write_str(message)
            }
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<Error> for DriverError {
    fn from(error: Error) -> Self {
        match error {
            Error::Validation(message) => DriverError::invalid(message),
            Error::Infrastructure(message) => DriverError::internal(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_driver_sdk::ErrorCode;

    #[test]
    fn a_message_reaches_the_host_as_it_was_written() {
        let invalid: DriverError = Error::Validation("No server answered".into()).into();
        assert_eq!(invalid.code, ErrorCode::Invalid);
        assert_eq!(invalid.message, "No server answered");
        let internal: DriverError = Error::Infrastructure("disk".into()).into();
        assert_eq!(internal.code, ErrorCode::Internal);
        assert_eq!(Error::Validation("x".into()).to_string(), "x");
    }
}
