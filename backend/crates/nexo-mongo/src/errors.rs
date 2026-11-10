//! Driver errors as Nexo shows them: what went wrong and what to check. The driver is built
//! with `redact-errors`, so server errors about credentials come without them.
use mongodb::error::{Error as DriverError, ErrorKind};
use nexo_domain::Error;

/// A driver error as a message for the person.
pub fn driver(error: DriverError) -> Error {
    let message = match error.kind.as_ref() {
        ErrorKind::Authentication { message, .. } => format!(
            "Authentication failed: check the user, the password and the authentication database ({message})"
        ),
        ErrorKind::ServerSelection { message, .. } => server_selection(message),
        ErrorKind::DnsResolve { message, .. } => {
            format!("Cannot resolve the server name: {message}")
        }
        ErrorKind::InvalidArgument { message, .. } => {
            format!("Invalid connection settings: {message}")
        }
        ErrorKind::InvalidTlsConfig { message, .. } => {
            // The driver names the file Nexo wrote; the person only knows the field.
            let reason = message.split(" from ").next().unwrap_or(message);
            format!("Invalid TLS certificate or key: {reason}")
        }
        ErrorKind::Command(command) => format!(
            "The server refused the command: {} ({})",
            command.message, command.code_name
        ),
        _ => error.to_string(),
    };
    Error::Validation(message)
}

/// No server could be used: the reason the driver gives, with a hint for the usual ones.
fn server_selection(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    let hint = if lower.contains("certificate") || lower.contains("unknownissuer") {
        " The server's certificate is not trusted: add its CA certificate in the TLS settings, or allow invalid certificates."
    } else if lower.contains("refused") {
        " Nothing is listening at that address and port."
    } else if lower.contains("timed out") || lower.contains("timeout") {
        " Check the address, the port and whether TLS is needed."
    } else {
        ""
    };
    format!("No server answered: {message}.{hint}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_a_hint_to_the_usual_failures() {
        assert!(
            server_selection("invalid peer certificate: UnknownIssuer")
                .contains("add its CA certificate")
        );
        assert!(
            server_selection("Connection refused (os error 111)").contains("Nothing is listening")
        );
        assert!(server_selection("timed out").contains("whether TLS is needed"));
        assert_eq!(server_selection("other"), "No server answered: other.");
    }
}
