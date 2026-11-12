//! Comparing two collections (of one connection or of two), a page at a time and never whole
//! in memory: the source is read in pages sorted by the key, and each page's documents are
//! looked up in the target by their keys (`$in`); then the target is read the same way to
//! find what the source lacks. Documents that differ are compared field by field.
mod sync;

use crate::{
    Application,
    ports::{DatabaseConnection, FindRequest},
};
use nexo_domain::{
    Result,
    diff::{FieldDifference, differences, value_at},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;

/// Documents read at once from each side.
const PAGE: u64 = 1_000;
/// Differences described when the client does not say, and at most.
pub(crate) const KEPT: u64 = 200;
pub(crate) const KEPT_MAX: u64 = 1_000;

/// A collection of a connection.
pub(crate) struct Side {
    pub connection: DatabaseConnection,
    pub database: String,
    pub collection: String,
}

/// How a document of one side stands against the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    OnlySource,
    OnlyTarget,
    Different,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Counts {
    pub only_source: u64,
    pub only_target: u64,
    pub different: u64,
    pub equal: u64,
    /// Documents without the key, which cannot be paired.
    pub without_key: u64,
}

/// What a comparison looks at: the filter of both sides, the key and the fields left out.
pub(crate) struct Rules {
    pub filter: Option<Value>,
    pub key: String,
    pub ignore: Vec<String>,
}

/// What the comparison finds, document by document.
pub(crate) trait Visitor {
    /// A document of one side, its pair if any, and the fields that differ.
    fn visit(
        &mut self,
        kind: Kind,
        key: &Value,
        source: Option<&Value>,
        fields: Vec<FieldDifference>,
    );
}

fn key_text(key: &Value) -> String {
    key.to_string()
}

impl Application {
    /// Every document of a find, reading all its pages.
    async fn every(&self, id: &str, side: &Side, filter: Value) -> Result<Vec<Value>> {
        let request = FindRequest {
            id: id.into(),
            database: side.database.clone(),
            collection: side.collection.clone(),
            filter: Some(filter),
            page_size: PAGE,
            ..Default::default()
        };
        let mut page = self.database.find(side.connection.clone(), request).await?;
        let mut documents = std::mem::take(&mut page.documents);
        while let Some(cursor) = page.cursor.take() {
            page = self.database.more(&cursor, id, PAGE).await?;
            documents.append(&mut page.documents);
        }
        Ok(documents)
    }

    /// The documents of `side` whose keys are among `keys`, by key.
    async fn by_keys(
        &self,
        id: &str,
        side: &Side,
        rules: &Rules,
        keys: &[Value],
    ) -> Result<HashMap<String, Value>> {
        let mut lookup = json!({ rules.key.clone(): { "$in": keys } });
        if let Some(filter) = &rules.filter {
            lookup = json!({ "$and": [filter, lookup] });
        }
        let mut found = HashMap::new();
        for document in self.every(id, side, lookup).await? {
            if let Some(key) = value_at(&document, &rules.key) {
                found.entry(key_text(key)).or_insert(document);
            }
        }
        Ok(found)
    }

    /// The first page of `from`, sorted by the key.
    async fn first_page(
        &self,
        id: &str,
        from: &Side,
        rules: &Rules,
    ) -> Result<crate::ports::DocumentPage> {
        let request = FindRequest {
            id: id.into(),
            database: from.database.clone(),
            collection: from.collection.clone(),
            filter: rules.filter.clone(),
            sort: Some(json!({ rules.key.clone(): 1 })),
            page_size: PAGE,
            ..Default::default()
        };
        self.database.find(from.connection.clone(), request).await
    }

    /// Compares the two sides, telling `visitor` each document that differs.
    pub(crate) async fn compare_sides<V: Visitor + Send>(
        &self,
        id: &str,
        source: &Side,
        target: &Side,
        rules: &Rules,
        visitor: &mut V,
    ) -> Result<Counts> {
        let mut counts = Counts::default();
        // The source, a page at a time: each document with its pair in the target, if any.
        let mut page = self.first_page(id, source, rules).await?;
        loop {
            let documents = std::mem::take(&mut page.documents);
            let keys = keys(&documents, &rules.key, &mut counts.without_key);
            let paired = self.by_keys(id, target, rules, &keys).await?;
            for document in &documents {
                let Some(key) = value_at(document, &rules.key) else {
                    continue;
                };
                match paired.get(&key_text(key)) {
                    None => {
                        counts.only_source += 1;
                        visitor.visit(Kind::OnlySource, key, Some(document), Vec::new());
                    }
                    Some(other) => {
                        let fields = differences(document, other, &rules.ignore);
                        if fields.is_empty() {
                            counts.equal += 1;
                        } else {
                            counts.different += 1;
                            visitor.visit(Kind::Different, key, Some(document), fields);
                        }
                    }
                }
            }
            match page.cursor.take() {
                Some(cursor) => page = self.database.more(&cursor, id, PAGE).await?,
                None => break,
            }
        }
        // The target the same way: what the source lacks.
        let mut page = self.first_page(id, target, rules).await?;
        loop {
            let documents = std::mem::take(&mut page.documents);
            let keys = keys(&documents, &rules.key, &mut counts.without_key);
            let paired = self.by_keys(id, source, rules, &keys).await?;
            for key in &keys {
                if !paired.contains_key(&key_text(key)) {
                    counts.only_target += 1;
                    visitor.visit(Kind::OnlyTarget, key, None, Vec::new());
                }
            }
            match page.cursor.take() {
                Some(cursor) => page = self.database.more(&cursor, id, PAGE).await?,
                None => break,
            }
        }
        Ok(counts)
    }
}

/// The keys of a page; the documents that have none are counted.
fn keys(documents: &[Value], key: &str, without: &mut u64) -> Vec<Value> {
    let mut keys = Vec::with_capacity(documents.len());
    for document in documents {
        match value_at(document, key) {
            Some(value) => keys.push(value.clone()),
            None => *without += 1,
        }
    }
    keys
}

/// The differences a comparison describes, up to a number.
pub(crate) struct Described {
    pub kept: usize,
    pub differences: Vec<Value>,
    pub truncated: bool,
}
impl Visitor for Described {
    fn visit(&mut self, kind: Kind, key: &Value, _: Option<&Value>, fields: Vec<FieldDifference>) {
        if self.differences.len() >= self.kept {
            self.truncated = true;
            return;
        }
        let mut difference = json!({ "kind": kind, "key": key });
        if !fields.is_empty() {
            difference["fields"] = json!(fields);
        }
        self.differences.push(difference);
    }
}
