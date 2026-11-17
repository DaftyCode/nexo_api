//! Plans of SQLite 3.50, as `EXPLAIN QUERY PLAN` gave them (`id|parent|detail`).
use super::read;
use nexo_driver_sdk::explain::{PlanNode, flags};

fn count(nodes: &[PlanNode]) -> usize {
    nodes.iter().map(|node| 1 + count(&node.children)).sum()
}

#[test]
fn reads_a_join_with_a_full_scan_a_key_search_and_a_temporary_sort() {
    let rows = include_str!("../../tests/plans/sqlite-3.50.4-join.txt");
    let plan = read(rows).unwrap();
    assert_eq!(count(&plan.nodes), rows.lines().count());
    let [scan, search, sort] = &plan.nodes[..] else {
        panic!("three nodes at the top");
    };
    assert_eq!(scan.operation, "SCAN");
    assert_eq!(scan.object.as_deref(), Some("o"));
    assert!(scan.flags.contains(&flags::FULL_SCAN.to_owned()));
    assert_eq!(search.operation, "SEARCH USING INTEGER PRIMARY KEY");
    assert_eq!(search.index.as_deref(), Some("INTEGER PRIMARY KEY"));
    assert_eq!(search.object.as_deref(), Some("c"));
    assert_eq!(search.condition.as_deref(), Some("rowid=?"));
    assert!(search.flags.is_empty());
    assert!(sort.flags.contains(&flags::TEMPORARY.to_owned()));
    assert_eq!(
        plan.original,
        "QUERY PLAN\n|--SCAN o\n|--SEARCH c USING INTEGER PRIMARY KEY (rowid=?)\n`--USE TEMP B-TREE FOR ORDER BY"
    );
}

#[test]
fn reads_nested_subqueries_and_indexes() {
    let rows = include_str!("../../tests/plans/sqlite-3.50.4-subquery.txt");
    let plan = read(rows).unwrap();
    assert_eq!(count(&plan.nodes), rows.lines().count());
    let compound = &plan.nodes[0];
    assert_eq!(compound.operation, "COMPOUND QUERY");
    let left = &compound.children[0];
    let search = &left.children[0];
    assert_eq!(search.operation, "SEARCH USING INDEX");
    assert_eq!(search.index.as_deref(), Some("orders_status"));
    assert_eq!(search.condition.as_deref(), Some("status=?"));
    let covering = &compound.children[1].children[0];
    assert_eq!(covering.operation, "SCAN USING COVERING INDEX");
    assert_eq!(covering.index.as_deref(), Some("orders_status"));
    assert!(covering.flags.is_empty());
}

#[test]
fn reads_the_words_of_versions_before_3_36() {
    let plan = read("3|0|SCAN TABLE orders AS o\n7|0|SEARCH TABLE customers AS c USING INTEGER PRIMARY KEY (rowid=?)").unwrap();
    assert_eq!(plan.nodes[0].object.as_deref(), Some("orders"));
    assert_eq!(plan.nodes[0].details["Alias"], "o");
    assert_eq!(plan.nodes[1].object.as_deref(), Some("customers"));
    assert!(read("not a plan").is_err());
}
