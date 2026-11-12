//! The operations of a definition and their parameters.
use super::*;

/// HTTP methods of a path item.
pub(crate) const METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];

/// An operation of the definition.
pub(crate) struct Operation<'a> {
    pub path: &'a str,
    pub method: &'static str,
    pub pointer: String,
    pub value: &'a Value,
    pub item: &'a Value,
    pub item_pointer: String,
}
pub(crate) fn operations(spec: &Spec) -> Vec<Operation<'_>> {
    let mut found = Vec::new();
    let Some(paths) = spec.root["paths"].as_object() else {
        return found;
    };
    for (path, item) in paths {
        let at = pointer("/paths", path);
        let (item, item_pointer) = spec.resolve(item, &at);
        for method in METHODS {
            if let Some(value) = item.get(method).filter(|value| value.is_object()) {
                found.push(Operation {
                    path,
                    method,
                    pointer: pointer(&item_pointer, method),
                    value,
                    item,
                    item_pointer: item_pointer.clone(),
                });
            }
        }
    }
    found
}

/// A parameter of an operation, with path-level ones it does not override.
pub(crate) struct Parameter<'a> {
    pub name: &'a str,
    pub location: &'a str,
    pub value: &'a Value,
    pub pointer: String,
}
pub(crate) fn parameters<'a>(spec: &'a Spec, operation: &Operation<'a>) -> Vec<Parameter<'a>> {
    let read = |list: &'a Value, at: &str| -> Vec<Parameter<'a>> {
        list.as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, raw)| {
                let (value, place) = spec.resolve(raw, &pointer(at, &index.to_string()));
                Parameter {
                    name: value["name"].as_str().unwrap_or(""),
                    location: value["in"].as_str().unwrap_or(""),
                    value,
                    pointer: place,
                }
            })
            .collect()
    };
    let own = read(
        &operation.value["parameters"],
        &pointer(&operation.pointer, "parameters"),
    );
    let mut all: Vec<Parameter<'a>> = read(
        &operation.item["parameters"],
        &pointer(&operation.item_pointer, "parameters"),
    )
    .into_iter()
    .filter(|shared| {
        !own.iter()
            .any(|p| p.name == shared.name && p.location == shared.location)
    })
    .collect();
    all.extend(own);
    all
}

/// The variables of a path template: `/users/{id}` has `id`.
pub(crate) fn template_variables(path: &str) -> Vec<&str> {
    path.split('{')
        .skip(1)
        .filter_map(|part| part.split_once('}').map(|(name, _)| name))
        .collect()
}
