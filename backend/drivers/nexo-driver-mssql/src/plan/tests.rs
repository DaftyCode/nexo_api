//! Showplans of SQL Server 2022, as the fixture's server wrote them.
use super::read;
use nexo_driver_sdk::explain::{PlanNode, flags};

fn all(nodes: &[PlanNode]) -> Vec<&PlanNode> {
    nodes
        .iter()
        .flat_map(|node| std::iter::once(node).chain(all(&node.children)))
        .collect()
}
/// Operators and statements: every `RelOp` and `StmtSimple` of the document.
fn written(original: &str) -> usize {
    original.matches("<RelOp ").count() + original.matches("<StmtSimple ").count()
}

#[test]
fn reads_an_estimated_join_without_losing_operators() {
    let original = include_str!("../../tests/plans/mssql-2022-estimated-join.xml");
    let plan = read(original).unwrap();
    assert_eq!(plan.format, "xml");
    assert_eq!(all(&plan.nodes).len(), written(original));
    let statement = &plan.nodes[0];
    assert_eq!(statement.operation, "SELECT");
    assert!(statement.details["StatementText"].contains("ORDER BY o.total"));
    let join = &statement.children[0];
    assert_eq!(join.operation, "Nested Loops (Inner Join)");
    let scan = all(&plan.nodes)
        .into_iter()
        .find(|node| node.object.as_deref() == Some("shop.orders"))
        .unwrap();
    assert!(scan.flags.contains(&flags::FULL_SCAN.to_owned()));
    assert_eq!(scan.details["Alias"], "o");
    assert!(scan.condition.as_deref().unwrap().contains("10"));
    let seek = all(&plan.nodes)
        .into_iter()
        .find(|node| node.object.as_deref() == Some("shop.customers"))
        .unwrap();
    assert!(seek.operation.contains("Seek"));
    assert!(seek.index.is_some());
    assert!(seek.condition.as_deref().unwrap().starts_with("id = "));
    assert_eq!(plan.total_ms, None);
}

#[test]
fn reads_the_measures_of_a_query_and_of_an_update() {
    let original = include_str!("../../tests/plans/mssql-2022-actual-sort.xml");
    let plan = read(original).unwrap();
    assert_eq!(all(&plan.nodes).len(), written(original));
    let top = &plan.nodes[0].children[0];
    assert_eq!(top.actual_rows, Some(5.0));
    assert_eq!(top.loops, Some(1.0));
    assert!(plan.total_ms.is_some());

    let original = include_str!("../../tests/plans/mssql-2022-actual-update.xml");
    let plan = read(original).unwrap();
    let update = &plan.nodes[0].children[0];
    assert_eq!(update.operation, "Clustered Index Update (Update)");
    assert_eq!(update.object.as_deref(), Some("dbo.numbers"));
    assert_eq!(update.actual_rows, Some(99.0));
    assert!(update.condition.as_deref().unwrap().starts_with("n < "));
    assert!(update.details.contains_key("ActualLogicalReads"));
}

#[test]
fn what_is_not_a_showplan_is_an_error() {
    assert!(read("<other/>").is_err());
    assert!(read("not xml <").is_err());
    assert!(read("").is_err());
}

#[test]
fn an_estimate_declares_the_parameters_instead_of_binding_them() {
    use nexo_driver_sdk::{
        Value,
        explain::{ExplainMode, ExplainParams, PlanReader},
    };
    let params = ExplainParams {
        connection: "c".into(),
        statement: "s".into(),
        sql: "SELECT 1 WHERE @P1 = @P2".into(),
        params: vec![Value::Integer(1), Value::Text("a'b".into())],
        mode: ExplainMode::Estimated,
        writes: false,
    };
    let steps = super::SqlServerPlans.steps(&params).unwrap();
    assert_eq!(
        steps.plan,
        "/* nexo:results */\nDECLARE @P1 bigint, @P2 nvarchar(4000);\nSELECT 1 WHERE @P1 = @P2"
    );
    assert_eq!(steps.params, Some(Vec::new()));
    let actual = ExplainParams {
        mode: ExplainMode::Actual,
        ..params
    };
    assert_eq!(super::SqlServerPlans.steps(&actual).unwrap().params, None);
}
