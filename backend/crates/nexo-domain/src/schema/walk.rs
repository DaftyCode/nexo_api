//! Reads the documents once, field by field, and sums up each field path.
use super::types::{Order, is_container, length, order};
use super::*;
use serde_json::Map;
use std::collections::HashMap;

#[derive(Default)]
struct TypeTally {
    count: u64,
    min: Option<(Order, Value)>,
    max: Option<(Order, Value)>,
    lengths: Option<(u64, u64, u64, u64)>,
}

#[derive(Default)]
struct Tally {
    name: String,
    depth: usize,
    count: u64,
    /// Times it was a document or an object, so its fields could be there.
    containers: u64,
    types: Vec<(&'static str, TypeTally)>,
    values: Vec<(Value, u64)>,
    value_index: HashMap<String, usize>,
    capped: bool,
    children: Vec<String>,
}

/// The schema of `documents`.
pub fn analyze<'a>(documents: impl IntoIterator<Item = &'a Value>, flavor: Flavor) -> SchemaReport {
    let mut walk = Walk {
        flavor,
        fields: HashMap::new(),
        roots: Vec::new(),
        sampled: 0,
        truncated: false,
    };
    for document in documents {
        walk.sampled += 1;
        if let Value::Object(fields) = document {
            walk.document("", fields, 0);
        }
    }
    walk.report()
}

struct Walk {
    flavor: Flavor,
    fields: HashMap<String, Tally>,
    roots: Vec<String>,
    sampled: u64,
    truncated: bool,
}

impl Walk {
    fn document(&mut self, parent: &str, fields: &Map<String, Value>, depth: usize) {
        for (name, value) in fields {
            self.value(parent, name, value, depth);
        }
    }

    fn value(&mut self, parent: &str, name: &str, value: &Value, depth: usize) {
        let path = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}.{name}")
        };
        if !self.fields.contains_key(&path) {
            if self.fields.len() >= MAX_FIELDS {
                self.truncated = true;
                return;
            }
            let siblings = match self.fields.get_mut(parent) {
                Some(tally) => &mut tally.children,
                None => &mut self.roots,
            };
            siblings.push(path.clone());
            let tally = Tally {
                name: name.to_string(),
                depth,
                ..Default::default()
            };
            self.fields.insert(path.clone(), tally);
        }
        let name = type_name(value, self.flavor);
        let tally = self.fields.get_mut(&path).expect("added above");
        tally.count += 1;
        tally.add(name, value);
        if depth >= MAX_DEPTH {
            return;
        }
        match value {
            Value::Object(fields) if name == "Document" || name == "Object" => {
                tally.containers += 1;
                self.document(&path, fields, depth + 1);
            }
            Value::Array(items) => {
                for item in items {
                    self.value(&path, "[]", item, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn report(mut self) -> SchemaReport {
        let mut fields = Vec::with_capacity(self.fields.len());
        let roots = std::mem::take(&mut self.roots);
        self.emit(&roots, self.sampled, &mut fields);
        SchemaReport {
            sampled: self.sampled,
            fields,
            truncated: self.truncated,
        }
    }

    /// Writes `paths` and their fields, depth first.
    fn emit(&mut self, paths: &[String], parents: u64, out: &mut Vec<FieldSchema>) {
        for path in paths {
            let Some(tally) = self.fields.remove(path) else {
                continue;
            };
            // The items of an array are all there by definition.
            let parents = if tally.name == "[]" {
                tally.count
            } else {
                parents
            };
            let containers = tally.containers;
            let children = tally.children.clone();
            out.push(tally.summary(path, parents));
            self.emit(&children, containers, out);
        }
    }
}

impl Tally {
    fn add(&mut self, name: &'static str, value: &Value) {
        let index = match self.types.iter().position(|(known, _)| *known == name) {
            Some(index) => index,
            None => {
                self.types.push((name, TypeTally::default()));
                self.types.len() - 1
            }
        };
        let tally = &mut self.types[index].1;
        tally.count += 1;
        if let Some(position) = order(value, name) {
            if tally.min.as_ref().is_none_or(|(min, _)| position < *min) {
                tally.min = Some((position.clone(), value.clone()));
            }
            if tally.max.as_ref().is_none_or(|(max, _)| position > *max) {
                tally.max = Some((position, value.clone()));
            }
        }
        if let Some(length) = length(value) {
            let (min, max, total, count) = tally.lengths.unwrap_or((u64::MAX, 0, 0, 0));
            tally.lengths = Some((min.min(length), max.max(length), total + length, count + 1));
        }
        if is_container(name) || value.as_str().is_some_and(|text| text.len() > LONG_VALUE) {
            return;
        }
        let key = value.to_string();
        match self.value_index.get(&key) {
            Some(&index) => self.values[index].1 += 1,
            None if self.values.len() < TRACKED_VALUES => {
                self.value_index.insert(key, self.values.len());
                self.values.push((value.clone(), 1));
            }
            None => self.capped = true,
        }
    }

    fn summary(self, path: &str, parents: u64) -> FieldSchema {
        let mut types: Vec<TypeSummary> = self
            .types
            .into_iter()
            .map(|(name, tally)| TypeSummary {
                name: name.to_string(),
                count: tally.count,
                min: tally.min.map(|(_, value)| value),
                max: tally.max.map(|(_, value)| value),
                lengths: tally.lengths.map(|(min, max, total, count)| Lengths {
                    min,
                    max,
                    average: total as f64 / count as f64,
                }),
            })
            .collect();
        types.sort_by_key(|summary| std::cmp::Reverse(summary.count));
        let distinct = self.values.len() as u64;
        let mut values: Vec<ValueCount> = self
            .values
            .into_iter()
            .map(|(value, count)| ValueCount { value, count })
            .collect();
        values.sort_by_key(|value| std::cmp::Reverse(value.count));
        values.truncate(TOP_VALUES);
        let mut anomalies = Vec::new();
        if types
            .iter()
            .filter(|summary| summary.name != "Null")
            .count()
            > 1
        {
            anomalies.push(Anomaly::MixedTypes);
        }
        if self.name != "[]"
            && parents >= FEW
            && self.count < parents
            && self.count as f64 >= parents as f64 * ALMOST_ALWAYS
        {
            anomalies.push(Anomaly::SometimesMissing);
        }
        FieldSchema {
            path: path.to_string(),
            name: self.name,
            depth: self.depth,
            count: self.count,
            parents,
            types,
            values,
            distinct,
            distinct_capped: self.capped,
            anomalies,
        }
    }
}
