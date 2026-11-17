//! The DDL SQL Server gets for each change.
use super::{unwrapped, writer::SqlServerWriter};
use nexo_driver_sdk::ddl::{ColumnModel, DdlPlanParams, KeyModel, TableModel, plan};

fn column(name: &str, type_name: &str, nullable: bool) -> ColumnModel {
    ColumnModel {
        name: name.into(),
        original: name.into(),
        type_name: type_name.into(),
        nullable,
        ..ColumnModel::default()
    }
}
fn items() -> TableModel {
    TableModel {
        schema: Some("dbo".into()),
        name: "items".into(),
        original: "items".into(),
        columns: vec![
            ColumnModel {
                identity: true,
                ..column("id", "int", false)
            },
            ColumnModel {
                default: Some("'none'".into()),
                ..column("label", "nvarchar(20)", true)
            },
        ],
        primary_key: Some(KeyModel {
            name: "PK_items".into(),
            columns: vec!["id".into()],
        }),
        ..TableModel::default()
    }
}

#[test]
fn creates_a_table_and_changes_a_column_with_its_default() {
    let mut new = items();
    new.original.clear();
    new.columns[1].comment = Some("its name".into());
    let created = plan(
        &SqlServerWriter,
        &DdlPlanParams {
            connection: "c".into(),
            original: None,
            target: Some(new),
            cascade: false,
        },
    )
    .unwrap();
    assert_eq!(
        created.statements[0],
        "CREATE TABLE [dbo].[items] (\n  [id] int IDENTITY(1,1) NOT NULL,\n  [label] nvarchar(20) NULL DEFAULT ('none'),\n  CONSTRAINT [PK_items] PRIMARY KEY ([id])\n)"
    );
    assert_eq!(
        created.statements[1],
        "EXEC sys.sp_addextendedproperty N'MS_Description', N'its name', N'SCHEMA', N'dbo', N'TABLE', N'items', N'COLUMN', N'label'"
    );
    let mut after = items();
    after.columns[1].type_name = "nvarchar(80)".into();
    let changed = plan(
        &SqlServerWriter,
        &DdlPlanParams {
            connection: "c".into(),
            original: Some(items()),
            target: Some(after),
            cascade: false,
        },
    )
    .unwrap();
    assert_eq!(changed.statements.len(), 3);
    assert!(changed.statements[0].starts_with("DECLARE @nexo_default sysname"));
    assert_eq!(
        changed.statements[1],
        "ALTER TABLE [dbo].[items] ALTER COLUMN [label] nvarchar(80) NULL"
    );
    assert_eq!(
        changed.statements[2],
        "ALTER TABLE [dbo].[items] ADD DEFAULT ('none') FOR [label]"
    );
    let mut identity = items();
    identity.columns[0].identity = false;
    let refused = plan(
        &SqlServerWriter,
        &DdlPlanParams {
            connection: "c".into(),
            original: Some(items()),
            target: Some(identity),
            cascade: false,
        },
    );
    assert!(refused.unwrap_err().message.contains("identity"));
}

#[test]
fn defaults_lose_the_parentheses_sql_server_adds() {
    assert_eq!(unwrapped("((0))"), "(0)");
    assert_eq!(unwrapped("('new')"), "'new'");
}
