//! How careful Nexo is with a connection, as DBeaver's connection types (DB-25): the three
//! built in (development, test and production) and the person's own, saved as
//! `connection-type` documents `{color, autoCommit, confirmWrites, confirmStructure, readOnly,
//! timeoutSeconds}`. A connection names one by its `type`: a built-in name or a document id.
use super::ConnectionType;
use crate::{DocumentId, Error, Result};
use serde_json::Value;
use std::time::Duration;

/// What a type asks of every session of its connections. The application applies them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TypeRules {
    /// A new session commits each statement; otherwise it waits for a commit.
    pub auto_commit: bool,
    /// A statement that writes or changes structure is confirmed first.
    pub confirm_writes: bool,
    /// A statement that changes structure (DDL) is confirmed first.
    pub confirm_structure: bool,
    /// Sessions only read, whatever the connection says.
    pub read_only: bool,
    /// The longest a statement may run, when the connection says nothing.
    pub timeout: Option<Duration>,
}

impl TypeRules {
    pub fn builtin(kind: ConnectionType) -> Self {
        let production = kind == ConnectionType::Production;
        Self {
            auto_commit: !production,
            confirm_writes: production,
            confirm_structure: production,
            ..Self::default()
        }
    }

    /// The rules of a type of the person's own, checked.
    pub fn read(value: &Value) -> Result<Self> {
        let flag = |field: &str| match value.get(field) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(flag)) => Ok(*flag),
            Some(_) => Err(Error::Validation(format!(
                "The rule {field} of a connection type is yes or no"
            ))),
        };
        let timeout = match value.get("timeoutSeconds") {
            None | Some(Value::Null) => None,
            Some(Value::Number(seconds))
                if seconds.as_u64().is_some_and(|s| (1..=3600).contains(&s)) =>
            {
                seconds.as_u64().map(Duration::from_secs)
            }
            Some(_) => {
                return Err(Error::Validation(
                    "The statement time limit is from 1 to 3600 seconds".into(),
                ));
            }
        };
        match value.get("color") {
            None | Some(Value::Null) => {}
            Some(Value::String(color)) if color.len() <= 32 => {}
            Some(_) => return Err(Error::Validation("The color of a type is a name".into())),
        }
        Ok(Self {
            auto_commit: flag("autoCommit")?,
            confirm_writes: flag("confirmWrites")?,
            confirm_structure: flag("confirmStructure")?,
            read_only: flag("readOnly")?,
            timeout,
        })
    }
}

/// The type a connection names: a built-in one, or the id of one of the person's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeOf {
    Builtin(ConnectionType),
    Own(DocumentId),
}

impl TypeOf {
    /// Reads the `type` of a connection: none is development.
    pub fn read(connection: &Value) -> Result<Self> {
        match connection.get("type") {
            None | Some(Value::Null) => Ok(Self::Builtin(ConnectionType::Development)),
            Some(Value::String(name)) => {
                match serde_json::from_value::<ConnectionType>(Value::String(name.clone())) {
                    Ok(kind) => Ok(Self::Builtin(kind)),
                    Err(_) => DocumentId::parse(name).map(Self::Own).map_err(|_| {
                        Error::Validation(
                            "A connection is for development, test, production or a type of yours"
                                .into(),
                        )
                    }),
                }
            }
            Some(_) => Err(Error::Validation(
                "A connection is for development, test, production or a type of yours".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn built_in_and_own_types_say_what_their_sessions_do() {
        let production = TypeRules::builtin(ConnectionType::Production);
        assert!(
            production.confirm_writes && production.confirm_structure && !production.auto_commit
        );
        assert_eq!(
            TypeRules::builtin(ConnectionType::Test),
            TypeRules {
                auto_commit: true,
                ..TypeRules::default()
            }
        );
        let own = TypeRules::read(&json!({"color": "amber", "autoCommit": true,
            "confirmStructure": true, "readOnly": true, "timeoutSeconds": 30}))
        .unwrap();
        assert_eq!(
            own,
            TypeRules {
                auto_commit: true,
                confirm_writes: false,
                confirm_structure: true,
                read_only: true,
                timeout: Some(Duration::from_secs(30)),
            }
        );
        for (value, message) in [
            (json!({"readOnly": "yes"}), "yes or no"),
            (json!({"timeoutSeconds": 0}), "time limit"),
            (json!({"color": 3}), "color"),
        ] {
            assert!(
                TypeRules::read(&value)
                    .unwrap_err()
                    .to_string()
                    .contains(message)
            );
        }
        assert_eq!(
            TypeOf::read(&json!({})).unwrap(),
            TypeOf::Builtin(ConnectionType::Development)
        );
        assert_eq!(
            TypeOf::read(&json!({"type": "production"})).unwrap(),
            TypeOf::Builtin(ConnectionType::Production)
        );
        assert_eq!(
            TypeOf::read(&json!({"type": "staging"})).unwrap(),
            TypeOf::Own(DocumentId::parse("staging").unwrap())
        );
        assert!(TypeOf::read(&json!({"type": ""})).is_err());
        assert!(TypeOf::read(&json!({"type": 7})).is_err());
    }
}
