//! Plans of PostgreSQL 18 and 14 (the fixture's servers), as `EXPLAIN` wrote them.
use super::read;
use nexo_driver_sdk::explain::{PlanNode, flags};

fn count(nodes: &[PlanNode]) -> usize {
    nodes.iter().map(|node| 1 + count(&node.children)).sum()
}
fn nodes_in(original: &str) -> usize {
    original.matches("\"Node Type\"").count()
}

#[test]
fn reads_an_estimated_join_of_every_version_without_losing_nodes() {
    for original in [
        include_str!("../../tests/plans/pg18-estimated-join.json"),
        include_str!("../../tests/plans/pg14-estimated-join.json"),
    ] {
        let plan = read(original).unwrap();
        assert_eq!(count(&plan.nodes), nodes_in(original));
        let sort = &plan.nodes[0];
        assert_eq!(sort.operation, "Sort");
        assert_eq!(sort.details["Sort Key"], "o.id");
        let join = &sort.children[0];
        assert_eq!(join.operation, "Hash Join");
        assert_eq!(join.condition.as_deref(), Some("(o.customer = c.id)"));
        let orders = &join.children[0];
        assert_eq!(orders.operation, "Seq Scan");
        assert_eq!(orders.object.as_deref(), Some("orders"));
        assert_eq!(orders.details["Alias"], "o");
        assert!(orders.flags.contains(&flags::FULL_SCAN.to_owned()));
        assert!(orders.condition.as_deref().unwrap().contains("10"));
        assert!(orders.estimated_rows.is_some() && orders.estimated_cost.is_some());
        assert_eq!(orders.actual_rows, None);
        assert_eq!(plan.total_ms, None);
    }
}

#[test]
fn reads_a_sort_on_disk_with_its_measures() {
    for original in [
        include_str!("../../tests/plans/pg18-actual-sort.json"),
        include_str!("../../tests/plans/pg14-actual-sort.json"),
    ] {
        let plan = read(original).unwrap();
        assert_eq!(count(&plan.nodes), nodes_in(original));
        let sort = &plan.nodes[0];
        assert!(sort.flags.contains(&flags::DISK_SORT.to_owned()));
        assert_eq!(sort.actual_rows, Some(99_990.0));
        assert_eq!(sort.loops, Some(1.0));
        assert!(sort.actual_ms.unwrap() > 0.0);
        assert!(sort.details.contains_key("Temp Written Blocks"));
        assert!(plan.total_ms.unwrap() > 0.0);
        assert_eq!(sort.children[0].object.as_deref(), Some("numbers"));
    }
}

#[test]
fn reads_the_actual_plan_of_an_update() {
    for original in [
        include_str!("../../tests/plans/pg18-actual-update.json"),
        include_str!("../../tests/plans/pg14-actual-update.json"),
    ] {
        let plan = read(original).unwrap();
        assert_eq!(count(&plan.nodes), nodes_in(original));
        let update = &plan.nodes[0];
        assert_eq!(update.operation, "Update");
        assert_eq!(update.object.as_deref(), Some("numbers"));
        let scan = &update.children[0];
        assert_eq!(scan.index.as_deref(), Some("numbers_pkey"));
        assert!(scan.condition.as_deref().unwrap().contains("100"));
        assert!(!scan.flags.contains(&flags::FULL_SCAN.to_owned()));
    }
}

#[test]
fn an_answer_that_is_not_a_plan_is_an_error() {
    assert!(read("not json").is_err());
    assert!(read("[]").is_err());
}
