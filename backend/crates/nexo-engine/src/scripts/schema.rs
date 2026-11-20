//! The JSON Schema validator scripts reach as `__nexoSchema(schema, value)`, both as JSON
//! text: the bootstrap keeps it for `jsonSchema` assertions and removes it from the globals.
//! It answers what `nexo_domain::schema::validate` finds, as JSON text.
use nexo_domain::schema::validate;
use rquickjs::{Context, Function};
use serde_json::{Value, json};

/// Checks `value` against `schema`, both JSON text; text that is not JSON is a problem.
fn check(schema: &str, value: &str) -> String {
    let parsed = |text: &str, what: &str| {
        serde_json::from_str::<Value>(text).map_err(|_| format!("The {what} is not JSON"))
    };
    let answer = match (parsed(schema, "schema"), parsed(value, "value")) {
        (Ok(schema), Ok(value)) => {
            serde_json::to_value(validate(&schema, &value)).unwrap_or_default()
        }
        (Err(message), _) | (_, Err(message)) => {
            json!({"problems": [{"path": "$", "message": message}], "patterns": []})
        }
    };
    answer.to_string()
}

pub(super) fn install(context: &Context) -> rquickjs::Result<()> {
    context.with(|ctx| {
        let function = Function::new(ctx.clone(), |schema: String, value: String| {
            check(&schema, &value)
        })?;
        ctx.globals().set("__nexoSchema", function)
    })
}
