//! Plans of MySQL 8.4 (both formats) and MariaDB 11.4, as the fixture's servers wrote them.
use super::read;
use nexo_driver_sdk::explain::{PlanNode, flags};

fn all(nodes: &[PlanNode]) -> Vec<&PlanNode> {
    nodes
        .iter()
        .flat_map(|node| std::iter::once(node).chain(all(&node.children)))
        .collect()
}
fn table<'a>(nodes: &'a [PlanNode], name: &str) -> &'a PlanNode {
    all(nodes)
        .into_iter()
        .find(|node| node.object.as_deref() == Some(name))
        .unwrap()
}

#[test]
fn reads_mysql_blocks_with_every_table() {
    let original = include_str!("../../tests/plans/mysql-8.4-v1-estimated-join.json");
    let plan = read(original).unwrap();
    assert_eq!(plan.format, "json");
    let block = &plan.nodes[0];
    assert_eq!(block.operation, "Query block #1");
    assert_eq!(block.estimated_cost, Some(1.9));
    assert_eq!(block.children[0].operation, "Sort");
    assert_eq!(block.children[0].details["using_filesort"], "true");
    let orders = table(&plan.nodes, "o");
    assert_eq!(orders.operation, "Full table scan");
    assert!(orders.flags.contains(&flags::FULL_SCAN.to_owned()));
    assert_eq!(
        orders.condition.as_deref(),
        Some("(`shop`.`o`.`total` > 10.00)")
    );
    assert_eq!(orders.estimated_rows, Some(3.0));
    let customers = table(&plan.nodes, "c");
    assert_eq!(customers.operation, "Unique index lookup");
    assert_eq!(customers.index.as_deref(), Some("PRIMARY"));
    assert_eq!(original.matches("\"table\"").count(), 2);
    assert_eq!(
        all(&plan.nodes)
            .iter()
            .filter(|node| node.object.is_some())
            .count(),
        2
    );
}

#[test]
fn reads_mysql_iterators_estimated_and_measured() {
    let estimated = read(include_str!(
        "../../tests/plans/mysql-8.4-v2-estimated-join.json"
    ))
    .unwrap();
    let join = &estimated.nodes[0];
    assert_eq!(join.operation, "Nested loop inner join");
    let scan = table(&estimated.nodes, "orders");
    assert_eq!(scan.operation, "Table scan on o");
    assert!(scan.flags.contains(&flags::FULL_SCAN.to_owned()));
    let lookup = table(&estimated.nodes, "customers");
    assert_eq!(lookup.index.as_deref(), Some("PRIMARY"));
    assert_eq!(lookup.condition.as_deref(), Some("id=o.customer"));
    let original = include_str!("../../tests/plans/mysql-8.4-v2-estimated-join.json");
    assert_eq!(
        all(&estimated.nodes).len(),
        original.matches("\"operation\"").count()
    );

    let actual = read(include_str!(
        "../../tests/plans/mysql-8.4-v2-actual-sort.json"
    ))
    .unwrap();
    let sort = &actual.nodes[0];
    assert_eq!(sort.operation, "Sort: numbers.label");
    assert_eq!(sort.actual_rows, Some(99_990.0));
    assert_eq!(sort.loops, Some(1.0));
    assert!(actual.total_ms.unwrap() > 0.0);
    let range = table(&actual.nodes, "numbers");
    assert_eq!(range.index.as_deref(), Some("PRIMARY"));
    assert!(range.flags.is_empty());
}

#[test]
fn reads_mariadb_estimates_and_analyze() {
    let estimated = read(include_str!(
        "../../tests/plans/mariadb-11.4-estimated-join.json"
    ))
    .unwrap();
    assert_eq!(table(&estimated.nodes, "o").operation, "Full table scan");
    assert_eq!(
        table(&estimated.nodes, "c").index.as_deref(),
        Some("PRIMARY")
    );
    assert_eq!(estimated.total_ms, None);

    let sort = read(include_str!(
        "../../tests/plans/mariadb-11.4-actual-sort.json"
    ))
    .unwrap();
    let filesort = all(&sort.nodes)
        .into_iter()
        .find(|node| node.operation == "Sort")
        .unwrap();
    assert!(filesort.flags.contains(&flags::DISK_SORT.to_owned()));
    assert_eq!(filesort.details["sort_key"], "numbers.label");
    let numbers = table(&sort.nodes, "numbers");
    assert_eq!(numbers.actual_rows, Some(100_000.0));
    assert_eq!(numbers.estimated_rows, Some(100_344.0));
    assert!(numbers.actual_ms.unwrap() > 0.0);
    assert!(sort.total_ms.unwrap() > 0.0);

    let update = read(include_str!(
        "../../tests/plans/mariadb-11.4-actual-update.json"
    ))
    .unwrap();
    let numbers = table(&update.nodes, "numbers");
    assert_eq!(numbers.operation, "Update: Index range scan");
    assert_eq!(numbers.actual_rows, Some(99.0));
}

#[test]
fn a_change_mysql_cannot_measure_is_said() {
    let error =
        read(r#"{"operation": "<not executable by iterator executor>", "query_type": "update"}"#)
            .unwrap_err();
    assert!(error.message.contains("only queries"));
    assert!(read("[]").is_err());
}
