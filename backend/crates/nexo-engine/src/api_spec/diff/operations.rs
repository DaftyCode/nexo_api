//! What changed in an operation: its parameters, request bodies and responses.
use super::*;

pub(super) fn compare_operation(changes: &mut Changes, before: &Operation, after: &Operation) {
    let (base, source) = (changes.base, changes.source);
    // Parameters, by location and name. A path variable is matched by position.
    let old_parameters = parameters(base, before);
    let new_parameters = parameters(source, after);
    let old_variables = super::super::template_variables(before.path);
    let new_variables = super::super::template_variables(after.path);
    let same = |old: &super::super::Parameter, new: &super::super::Parameter| {
        old.location == new.location
            && (old.name == new.name
                || (old.location == "path"
                    && old_variables.iter().position(|v| *v == old.name)
                        == new_variables.iter().position(|v| *v == new.name)))
    };
    for new in new_parameters.iter().filter(|p| p.location != "body") {
        let required = new.value["required"] == true;
        match old_parameters.iter().find(|old| same(old, new)) {
            None if required => changes.add(
                "parameter-added-required",
                &[new.location, new.name],
                true,
                &new.pointer,
                Side::Source,
            ),
            None => changes.add(
                "parameter-added",
                &[new.location, new.name],
                false,
                &new.pointer,
                Side::Source,
            ),
            Some(old) => {
                if required && old.value["required"] != true {
                    changes.add(
                        "parameter-required",
                        &[new.location, new.name],
                        true,
                        &new.pointer,
                        Side::Source,
                    );
                }
                let schema = |spec: &Spec, parameter: &super::super::Parameter| {
                    if spec.version() == Version::Swagger2 {
                        (parameter.value.clone(), parameter.pointer.clone())
                    } else {
                        (
                            parameter.value["schema"].clone(),
                            pointer(&parameter.pointer, "schema"),
                        )
                    }
                };
                let (old_schema, old_at) = schema(base, old);
                let (new_schema, new_at) = schema(source, new);
                let place = format!("{} {}", new.location, new.name);
                compare_schema(
                    changes,
                    (&old_schema, &old_at),
                    (&new_schema, &new_at),
                    &place,
                    Direction::Request,
                    0,
                );
            }
        }
    }
    for old in old_parameters.iter().filter(|p| p.location != "body") {
        if !new_parameters.iter().any(|new| same(old, new)) {
            changes.add(
                "parameter-removed",
                &[old.location, old.name],
                false,
                &old.pointer,
                Side::Base,
            );
        }
    }
    compare_bodies(changes, before, after);
    compare_responses(changes, before, after);
}

/// The request body schemas by media type, with the pointer to each, and whether required.
pub(super) fn bodies(spec: &Spec, operation: &Operation) -> (MediaSchemas, bool, String) {
    if spec.version() == Version::Swagger2 {
        let body = parameters(spec, operation)
            .into_iter()
            .find(|p| p.location == "body");
        return match body {
            Some(body) => (
                vec![(
                    "body".into(),
                    body.value["schema"].clone(),
                    pointer(&body.pointer, "schema"),
                )],
                body.value["required"] == true,
                body.pointer,
            ),
            None => (Vec::new(), false, String::new()),
        };
    }
    let Some(raw) = operation.value.get("requestBody") else {
        return (Vec::new(), false, String::new());
    };
    let (body, at) = spec.resolve(raw, &pointer(&operation.pointer, "requestBody"));
    let content_at = pointer(&at, "content");
    let media = body["content"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(media, value)| {
            (
                media.clone(),
                value["schema"].clone(),
                pointer(&pointer(&content_at, media), "schema"),
            )
        })
        .collect();
    (media, body["required"] == true, at)
}

pub(super) fn compare_bodies(changes: &mut Changes, before: &Operation, after: &Operation) {
    let (old, old_required, old_at) = bodies(changes.base, before);
    let (new, new_required, new_at) = bodies(changes.source, after);
    match (old.is_empty(), new.is_empty()) {
        (true, true) => return,
        (true, false) => {
            changes.add("body-added", &[], new_required, &new_at, Side::Source);
            return;
        }
        (false, true) => {
            changes.add("body-removed", &[], false, &old_at, Side::Base);
            return;
        }
        _ => {}
    }
    if new_required && !old_required {
        changes.add("body-required", &[], true, &new_at, Side::Source);
    }
    // Swagger 2 has one body whatever its media type.
    let single = old.len() == 1 && new.len() == 1 && (old[0].0 == "body" || new[0].0 == "body");
    for (media, schema, at) in &old {
        let found = if single {
            new.first()
        } else {
            new.iter().find(|(name, _, _)| name == media)
        };
        match found {
            None => changes.add("body-media-removed", &[media], true, at, Side::Base),
            Some((_, new_schema, new_at)) => compare_schema(
                changes,
                (schema, at),
                (new_schema, new_at),
                &format!("body {media}"),
                Direction::Request,
                0,
            ),
        }
    }
}

/// The responses by status, with their schemas by media type.
pub(super) fn responses(spec: &Spec, operation: &Operation) -> Vec<(String, String, MediaSchemas)> {
    let at = pointer(&operation.pointer, "responses");
    operation.value["responses"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(status, raw)| {
            let (response, place) = spec.resolve(raw, &pointer(&at, status));
            let schemas = if spec.version() == Version::Swagger2 {
                response
                    .get("schema")
                    .map(|schema| {
                        vec![(
                            "body".to_string(),
                            schema.clone(),
                            pointer(&place, "schema"),
                        )]
                    })
                    .unwrap_or_default()
            } else {
                response["content"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(media, value)| {
                        (
                            media.clone(),
                            value["schema"].clone(),
                            pointer(&pointer(&pointer(&place, "content"), media), "schema"),
                        )
                    })
                    .collect()
            };
            (status.clone(), place, schemas)
        })
        .collect()
}

pub(super) fn compare_responses(changes: &mut Changes, before: &Operation, after: &Operation) {
    let old = responses(changes.base, before);
    let new = responses(changes.source, after);
    for (status, at, schemas) in &old {
        match new.iter().find(|(s, _, _)| s == status) {
            None => changes.add(
                "response-removed",
                &[status],
                status.starts_with('2'),
                at,
                Side::Base,
            ),
            Some((_, _, new_schemas)) => {
                let single = schemas.len() == 1 && new_schemas.len() == 1;
                for (media, schema, schema_at) in schemas {
                    let found = if single && (media == "body" || new_schemas[0].0 == "body") {
                        new_schemas.first()
                    } else {
                        new_schemas.iter().find(|(name, _, _)| name == media)
                    };
                    match found {
                        None => changes.add(
                            "response-media-removed",
                            &[status, media],
                            status.starts_with('2'),
                            schema_at,
                            Side::Base,
                        ),
                        Some((_, new_schema, new_at)) => compare_schema(
                            changes,
                            (schema, schema_at),
                            (new_schema, new_at),
                            &format!("response {status}"),
                            Direction::Response,
                            0,
                        ),
                    }
                }
            }
        }
    }
    for (status, at, _) in &new {
        if !old.iter().any(|(s, _, _)| s == status) {
            changes.add("response-added", &[status], false, at, Side::Source);
        }
    }
}
