//! Joining two people's changes to a shared collection, element by element: from what both
//! had last time they agreed (`base`), what this Nexo has (`ours`) and what the file has
//! now (`theirs`). What only one side changed is taken; an element both changed the same
//! way is that; an element both changed differently keeps theirs and is a conflict the
//! person resolves; an element one side deleted and the other did not touch is deleted, and
//! one deleted on one side but changed on the other is kept, so no work is lost. Folders
//! keep the place one side moved them to, and their order follows the side that changed it.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// The collection itself: its name, variables, authorization and scripts.
const ROOT: &str = "";

/// An element both sides changed differently: the collection keeps theirs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub id: String,
    pub name: String,
    pub mine: Value,
    pub theirs: Value,
}

/// The joined collection, and what the person has to choose.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub value: Value,
    pub conflicts: Vec<Conflict>,
}

#[derive(Debug, Clone)]
struct Node {
    parent: String,
    content: Value,
    folder: bool,
}

/// A collection by element: each one's parent and content, and each parent's children.
#[derive(Default)]
struct Flat {
    nodes: HashMap<String, Node>,
    children: HashMap<String, Vec<String>>,
}

fn without_items(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(name, _)| name.as_str() != "item")
                .map(|(name, item)| (name.clone(), item.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn flatten(collection: &Value) -> Flat {
    fn walk(items: &Value, parent: &str, path: &str, flat: &mut Flat) {
        for (index, item) in items.as_array().into_iter().flatten().enumerate() {
            let id = match item["id"].as_str().filter(|id| !id.is_empty()) {
                Some(id) => id.to_owned(),
                None => format!("~{path}/{index}"),
            };
            flat.children
                .entry(parent.to_owned())
                .or_default()
                .push(id.clone());
            let folder = item.get("item").is_some();
            flat.nodes.insert(
                id.clone(),
                Node {
                    parent: parent.to_owned(),
                    content: without_items(item),
                    folder,
                },
            );
            if folder {
                walk(&item["item"], &id, &id, flat);
            }
        }
    }
    let mut flat = Flat::default();
    flat.nodes.insert(
        ROOT.into(),
        Node {
            parent: ROOT.into(),
            content: without_items(collection),
            folder: true,
        },
    );
    walk(&collection["item"], ROOT, ROOT, &mut flat);
    flat
}

/// The content of an element both sides have.
fn joined(
    id: &str,
    base: Option<&Node>,
    ours: &Node,
    theirs: &Node,
    conflicts: &mut Vec<Conflict>,
) -> Value {
    if ours.content == theirs.content || base.is_some_and(|base| base.content == ours.content) {
        return theirs.content.clone();
    }
    if base.is_some_and(|base| base.content == theirs.content) {
        return ours.content.clone();
    }
    let name = theirs.content["name"]
        .as_str()
        .or(theirs.content["info"]["name"].as_str())
        .unwrap_or_default();
    conflicts.push(Conflict {
        id: id.into(),
        name: name.into(),
        mine: ours.content.clone(),
        theirs: theirs.content.clone(),
    });
    theirs.content.clone()
}

/// The children of `parent`: in the order of the side that changed it, with what the other
/// side added or moved here after the element it followed there.
fn order(
    parent: &str,
    base: &Flat,
    ours: &Flat,
    theirs: &Flat,
    kept: &HashMap<String, Node>,
) -> Vec<String> {
    let list = |flat: &Flat| flat.children.get(parent).cloned().unwrap_or_default();
    let (before, mine, other) = (list(base), list(ours), list(theirs));
    let (first, second) = if mine != before && other == before {
        (mine, other)
    } else {
        (other, mine)
    };
    let here =
        |id: &String| !id.is_empty() && kept.get(id).is_some_and(|node| node.parent == parent);
    let mut placed: Vec<String> = first.iter().filter(|id| here(id)).cloned().collect();
    let mut seen: HashSet<String> = placed.iter().cloned().collect();
    let mut rest: Vec<String> = second.clone();
    let mut others: Vec<String> = kept
        .iter()
        .filter(|(_, node)| node.parent == parent)
        .map(|(id, _)| id.clone())
        .collect();
    others.sort();
    rest.extend(others);
    for id in rest {
        if !here(&id) || !seen.insert(id.clone()) {
            continue;
        }
        let earlier: Vec<&String> = second.iter().take_while(|other| **other != id).collect();
        let after = earlier
            .iter()
            .rev()
            .find_map(|previous| placed.iter().position(|placed| placed == *previous));
        placed.insert(after.map_or(0, |at| at + 1), id);
    }
    placed
}

fn rebuild(
    id: &str,
    kept: &HashMap<String, Node>,
    children: &HashMap<String, Vec<String>>,
    seen: &mut HashSet<String>,
) -> Value {
    let node = &kept[id];
    let mut value = node.content.clone();
    if node.folder {
        let mut items = Vec::new();
        for child in children.get(id).into_iter().flatten() {
            if seen.insert(child.clone()) {
                items.push(rebuild(child, kept, children, seen));
            }
        }
        if let Value::Object(fields) = &mut value {
            fields.insert("item".into(), Value::Array(items));
        }
    }
    value
}

/// Joins the changes of `ours` and `theirs` since `base`.
pub fn merge(base: &Value, ours: &Value, theirs: &Value) -> Merged {
    let (base, ours, theirs) = (flatten(base), flatten(ours), flatten(theirs));
    let mut conflicts = Vec::new();
    let mut kept: HashMap<String, Node> = HashMap::new();
    let mut ids: Vec<&String> = theirs.nodes.keys().chain(ours.nodes.keys()).collect();
    ids.sort();
    ids.dedup();
    for id in ids {
        let before = base.nodes.get(id);
        let node = match (ours.nodes.get(id), theirs.nodes.get(id)) {
            (Some(mine), Some(other)) => {
                let moved = before.is_some_and(|before| before.parent != mine.parent);
                Node {
                    parent: if moved {
                        mine.parent.clone()
                    } else {
                        other.parent.clone()
                    },
                    content: joined(id, before, mine, other, &mut conflicts),
                    folder: other.folder,
                }
            }
            // Deleted on one side: gone if the other did not change it.
            (Some(only), None) | (None, Some(only)) => {
                if before.is_some_and(|before| before.content == only.content) {
                    continue;
                }
                only.clone()
            }
            (None, None) => continue,
        };
        kept.insert(id.clone(), node);
    }
    // An element whose folder is gone goes to the collection itself.
    let orphans: Vec<String> = kept
        .iter()
        .filter(|(id, node)| !id.is_empty() && !kept.contains_key(&node.parent))
        .map(|(id, _)| id.clone())
        .collect();
    for id in orphans {
        if let Some(node) = kept.get_mut(&id) {
            node.parent = ROOT.into();
        }
    }
    let parents: HashSet<String> = kept.values().map(|node| node.parent.clone()).collect();
    let children: HashMap<String, Vec<String>> = parents
        .into_iter()
        .map(|parent| {
            let list = order(&parent, &base, &ours, &theirs, &kept);
            (parent, list)
        })
        .collect();
    let mut seen = HashSet::from([ROOT.to_owned()]);
    let mut value = rebuild(ROOT, &kept, &children, &mut seen);
    // An element caught in a folder moved into itself still goes somewhere.
    let mut lost: Vec<&String> = kept.keys().filter(|id| !seen.contains(*id)).collect();
    lost.sort();
    let lost: Vec<Value> = lost
        .into_iter()
        .map(|id| {
            let mut content = kept[id].content.clone();
            if kept[id].folder
                && let Value::Object(fields) = &mut content
            {
                fields.insert("item".into(), Value::Array(Vec::new()));
            }
            content
        })
        .collect();
    if !lost.is_empty()
        && let Some(items) = value["item"].as_array_mut()
    {
        items.extend(lost);
    }
    Merged { value, conflicts }
}
