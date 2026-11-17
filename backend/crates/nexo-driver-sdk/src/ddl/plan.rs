//! The difference between a table and the same table changed, as the engine's statements.
use super::{ColumnModel, Constraint, DdlPlan, DdlPlanParams, DdlWriter, Step, TableModel};
use crate::{DriverError, Result};

fn constraints(table: &TableModel) -> Vec<Constraint> {
    let mut all = Vec::new();
    all.extend(table.primary_key.clone().map(Constraint::PrimaryKey));
    all.extend(table.uniques.iter().cloned().map(Constraint::Unique));
    all.extend(table.checks.iter().cloned().map(Constraint::Check));
    all.extend(
        table
            .foreign_keys
            .iter()
            .cloned()
            .map(Constraint::ForeignKey),
    );
    all
}

/// The columns of a table that a change keeps, without what only renames them.
fn same_definition(before: &ColumnModel, after: &ColumnModel) -> bool {
    before
        .type_name
        .trim()
        .eq_ignore_ascii_case(after.type_name.trim())
        && before.nullable == after.nullable
        && before.default.as_deref().map(str::trim) == after.default.as_deref().map(str::trim)
        && before.identity == after.identity
}

/// The statements that make `params.target` of `params.original`: a new table, a table
/// dropped, or the changes of one that exists.
pub fn plan(writer: &dyn DdlWriter, params: &DdlPlanParams) -> Result<DdlPlan> {
    let mut plan = DdlPlan {
        transactional: writer.transactional(),
        ..DdlPlan::default()
    };
    match (&params.original, &params.target) {
        (None, Some(table)) => {
            check(table)?;
            plan.statements = writer.create(table);
            for index in &table.indexes {
                plan.statements.push(writer.create_index(table, index));
            }
        }
        (Some(table), None) => {
            plan.statements = writer.drop(table, params.cascade);
            plan.warnings
                .push(format!("{} is dropped with all its rows", table.name));
        }
        (Some(before), Some(after)) => {
            check(after)?;
            alter(writer, before, after, &mut plan)?;
        }
        (None, None) => return Err(DriverError::invalid("Say which table to change")),
    }
    if !plan.transactional && plan.statements.len() > 1 {
        plan.warnings.push(
            "This engine commits each change of structure: a failure half way leaves the ones before it made"
                .into(),
        );
    }
    Ok(plan)
}

fn check(table: &TableModel) -> Result<()> {
    if table.name.trim().is_empty() {
        return Err(DriverError::invalid("The table needs a name"));
    }
    if table.columns.is_empty() {
        return Err(DriverError::invalid("The table needs at least one column"));
    }
    if let Some(column) = table
        .columns
        .iter()
        .find(|column| column.name.trim().is_empty())
    {
        return Err(DriverError::invalid(format!(
            "Every column needs a name ({} has none)",
            column.type_name
        )));
    }
    if let Some(column) = table
        .columns
        .iter()
        .find(|column| column.type_name.trim().is_empty())
    {
        return Err(DriverError::invalid(format!(
            "The column {} needs a type",
            column.name
        )));
    }
    Ok(())
}

/// Adds what a step makes; `false` when the table must be rebuilt instead.
fn take(step: Step, plan: &mut DdlPlan) -> Result<bool> {
    match step {
        Step::Run(statements) => {
            plan.statements.extend(statements);
            Ok(true)
        }
        Step::Rebuild => Ok(false),
        Step::Unsupported(why) => Err(DriverError::unsupported(why)),
    }
}

fn alter(
    writer: &dyn DdlWriter,
    before: &TableModel,
    after: &TableModel,
    plan: &mut DdlPlan,
) -> Result<()> {
    let mut current = before.clone();
    let mut in_place = true;
    if after.name != before.name {
        in_place &= take(writer.rename_table(&current, &after.name), plan)?;
        current.name = after.name.clone();
    }
    let (old, new) = (constraints(before), constraints(after));
    for constraint in old.iter().filter(|each| !new.contains(each)) {
        in_place &= take(writer.drop_constraint(&current, constraint), plan)?;
    }
    for index in before
        .indexes
        .iter()
        .filter(|each| !after.indexes.contains(each))
    {
        plan.statements.push(writer.drop_index(&current, index));
    }
    for column in &before.columns {
        if !after
            .columns
            .iter()
            .any(|each| each.original == column.name)
        {
            in_place &= take(writer.drop_column(&current, &column.name), plan)?;
            plan.warnings.push(format!(
                "The column {} is dropped with its values",
                column.name
            ));
        }
    }
    for column in &after.columns {
        if column.original.is_empty() {
            in_place &= take(writer.add_column(&current, column), plan)?;
            continue;
        }
        let Some(old) = before
            .columns
            .iter()
            .find(|each| each.name == column.original)
        else {
            return Err(DriverError::invalid(format!(
                "The table has no column {} to change",
                column.original
            )));
        };
        let mut renamed = old.clone();
        if column.name != old.name {
            in_place &= take(
                writer.rename_column(&current, &old.name, &column.name),
                plan,
            )?;
            renamed.name = column.name.clone();
        }
        if !same_definition(&renamed, column) {
            if !renamed
                .type_name
                .trim()
                .eq_ignore_ascii_case(column.type_name.trim())
            {
                plan.warnings.push(format!(
                    "{} changes from {} to {}: values that do not fit make it fail, or are cut",
                    column.name, renamed.type_name, column.type_name
                ));
            }
            in_place &= take(writer.alter_column(&current, &renamed, column), plan)?;
        }
        if renamed.comment != column.comment {
            in_place &= take(writer.column_comment(&current, &renamed, column), plan)?;
        }
    }
    for constraint in new.iter().filter(|each| !old.contains(each)) {
        in_place &= take(writer.add_constraint(&current, constraint), plan)?;
    }
    for index in after
        .indexes
        .iter()
        .filter(|each| !before.indexes.contains(each))
    {
        plan.statements.push(writer.create_index(&current, index));
    }
    if before.comment != after.comment {
        in_place &= take(
            writer.table_comment(
                &current,
                before.comment.as_deref(),
                after.comment.as_deref(),
            ),
            plan,
        )?;
    }
    if !in_place {
        rebuild(writer, before, after, plan);
    }
    Ok(())
}

/// The table created again with its new shape, its rows copied, and its indexes made again.
fn rebuild(writer: &dyn DdlWriter, before: &TableModel, after: &TableModel, plan: &mut DdlPlan) {
    let mut fresh = after.clone();
    fresh.name = format!("{}__nexo_new", after.name);
    let kept: Vec<(&str, &str)> = after
        .columns
        .iter()
        .filter(|column| !column.original.is_empty())
        .map(|column| (column.name.as_str(), column.original.as_str()))
        .collect();
    let mut statements = writer.create(&fresh);
    let into: Vec<String> = kept.iter().map(|(name, _)| writer.quote(name)).collect();
    let from: Vec<String> = kept
        .iter()
        .map(|(_, original)| writer.quote(original))
        .collect();
    if !kept.is_empty() {
        statements.push(format!(
            "INSERT INTO {} ({}) SELECT {} FROM {}",
            writer.table(&fresh),
            into.join(", "),
            from.join(", "),
            writer.table(before)
        ));
    }
    statements.extend(writer.drop(before, false));
    if let Step::Run(rename) = writer.rename_table(&fresh, &after.name) {
        statements.extend(rename);
    }
    for index in &after.indexes {
        statements.push(writer.create_index(after, index));
    }
    plan.statements = statements;
    plan.warnings.push(format!(
        "The engine cannot make this change in place: {} is created again and its rows copied; its triggers, and the views that use it, must be made again",
        after.name
    ));
}
