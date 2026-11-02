mod common;

use conduit_desktop::{
    agent_tools::{
        self, AgentToolContext, ADD_SHEET_TOOL, APPEND_ROWS_TOOL, CREATE_SPREADSHEET_TOOL,
        EDIT_SHEET_TOOL, READ_SPREADSHEET_TOOL, UPDATE_CELLS_TOOL, WRITE_HTML_TOOL,
    },
    db::repository::{artifacts, conversations},
    sheets,
};
use serde_json::{json, Value};

struct Env {
    pool: sqlx::SqlitePool,
    enc: conduit_desktop::encryption::Encryption,
    artifacts_dir: tempfile::TempDir,
    exports_dir: tempfile::TempDir,
    conversation_id: String,
}

async fn env() -> Env {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    Env {
        pool,
        enc,
        artifacts_dir: tempfile::tempdir().unwrap(),
        exports_dir: tempfile::tempdir().unwrap(),
        conversation_id: conv.id,
    }
}

async fn call(env: &Env, tool: &str, args: Value) -> (Value, bool) {
    let ctx = AgentToolContext {
        headless: false,
        db: &env.pool,
        artifacts_dir: env.artifacts_dir.path(),
        exports_dir: env.exports_dir.path(),
        encryption: &env.enc,
        conversation_id: &env.conversation_id,
        source_message_id: None,
        workspace: None,
        search: Default::default(),
        image: None,
    };
    let result = agent_tools::execute_builtin_tool(&ctx, "call", "req", tool, &args)
        .await
        .expect("tool runs");
    (result.output, result.is_error)
}

fn menu_board() -> Value {
    json!({
        "title": "Menu board",
        "sheets": [
            { "name": "Assumptions", "rows": [
                [{"value": "Item", "style": "header"}, {"value": "Value", "style": "header"}],
                ["Display", {"value": 700, "style": "input", "format": "currency"}],
                ["Tax", {"value": 0.1, "format": "percent", "style": "input"}]
            ]},
            { "name": "BOM", "freeze_header": true, "rows": [
                [{"value": "Item", "style": "header"}, {"value": "Cost", "style": "header"}],
                ["Display", {"formula": "=Assumptions!B2", "format": "currency"}],
                ["Tax", {"formula": "=B2*Assumptions!B3", "format": "currency"}],
                [{"value": "Total", "style": "total"}, {"formula": "=SUM(B2:B3)", "style": "total", "format": "currency"}]
            ]}
        ]
    })
}

#[tokio::test]
async fn create_stores_a_spreadsheet_artifact_and_reports_sizes() {
    let env = env().await;
    let (out, is_error) = call(&env, CREATE_SPREADSHEET_TOOL, menu_board()).await;
    assert!(!is_error, "{out}");
    assert_eq!(out["ok"], true);
    assert_eq!(out["created"], true);
    assert_eq!(out["errors"], json!([]));
    assert_eq!(
        out["sheets"],
        json!([
            {"name": "Assumptions", "rows": 3, "cols": 2},
            {"name": "BOM", "rows": 4, "cols": 2}
        ])
    );
    let id = out["artifact_id"].as_str().unwrap();
    let artifact = artifacts::get(&env.pool, &env.enc, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(artifact.kind, "spreadsheet");
    assert_eq!(artifact.title.as_deref(), Some("Menu board"));
    let stored = artifact.content_json.clone().expect("json content");
    assert_eq!(stored["sheets"][1]["name"], "BOM");
    assert_eq!(stored["sheets"][1]["rows"][3][1]["formula"], "=SUM(B2:B3)");

    // The panel's view calculates it: 700 + 70 = 770.
    let workbook = sheets::workbook_of(&artifact).unwrap();
    let computed = sheets::compute::compute(&workbook).unwrap();
    let total = computed.sheet("BOM").unwrap().rows[3][1].as_ref().unwrap();
    assert_eq!(total.display, "$770.00");
}

#[tokio::test]
async fn a_bad_spec_is_refused_with_the_cell_and_nothing_is_stored() {
    let env = env().await;
    let (out, is_error) = call(
        &env,
        CREATE_SPREADSHEET_TOOL,
        json!({"title": "x", "sheets": [{"name": "S", "rows": [[1, {"formula": "=WEBSERVICE(\"http://x\")"}]]}]}),
    )
    .await;
    assert!(is_error);
    let message = out["error"].as_str().unwrap();
    assert!(
        message.contains("'S'") && message.contains("B1") && message.contains("WEBSERVICE"),
        "{message}"
    );
    assert!(artifacts::list(&env.pool, &env.conversation_id)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn writes_report_formula_errors_and_update_cells_fixes_them() {
    let env = env().await;
    let (out, _) = call(
        &env,
        CREATE_SPREADSHEET_TOOL,
        json!({"title": "t", "sheets": [{"name": "S", "rows": [[2, {"formula": "=NOSUCH(A1)"}]]}]}),
    )
    .await;
    assert_eq!(
        out["errors"],
        json!([{"sheet": "S", "cell": "B1", "formula": "=NOSUCH(A1)", "error": "#NAME?"}])
    );
    let id = out["artifact_id"].as_str().unwrap().to_string();

    let (out, is_error) = call(
        &env,
        UPDATE_CELLS_TOOL,
        json!({"artifact_id": id, "sheet": "S", "start": "B1", "rows": [[{"formula": "=A1*21"}]]}),
    )
    .await;
    assert!(!is_error, "{out}");
    assert_eq!(out["errors"], json!([]));
    assert!(out.get("created").is_none());

    let (read, _) = call(&env, READ_SPREADSHEET_TOOL, json!({"artifact_id": id})).await;
    let cells = read["cells"].as_array().unwrap();
    assert_eq!(cells[1]["cell"], "B1");
    assert_eq!(cells[1]["value"], 42.0);
    assert_eq!(cells[1]["formula"], "=A1*21");

    // Scattered cells in one call.
    let (out, is_error) = call(
        &env,
        UPDATE_CELLS_TOOL,
        json!({"artifact_id": id, "sheet": "S",
               "cells": [{"cell": "A1", "value": 3}, {"cell": "D5", "formula": "=B1+1"}]}),
    )
    .await;
    assert!(!is_error, "{out}");
    let (read, _) = call(
        &env,
        READ_SPREADSHEET_TOOL,
        json!({"artifact_id": id, "sheet": "S", "range": "D5"}),
    )
    .await;
    assert_eq!(read["cells"][0]["value"], 64.0);

    // Neither form, or half a block, is refused.
    let (_, is_error) = call(
        &env,
        UPDATE_CELLS_TOOL,
        json!({"artifact_id": id, "sheet": "S"}),
    )
    .await;
    assert!(is_error);
    let (_, is_error) = call(
        &env,
        UPDATE_CELLS_TOOL,
        json!({"artifact_id": id, "sheet": "S", "start": "A1"}),
    )
    .await;
    assert!(is_error);
}

#[tokio::test]
async fn append_rows_builds_a_table_in_chunks() {
    let env = env().await;
    let (out, _) = call(
        &env,
        CREATE_SPREADSHEET_TOOL,
        json!({"title": "t", "more_to_write": true,
               "sheets": [{"name": "Data", "rows": [["n", "double"], [1, {"formula": "=A2*2"}]]}]}),
    )
    .await;
    let id = out["artifact_id"].as_str().unwrap().to_string();
    let (out, is_error) = call(
        &env,
        APPEND_ROWS_TOOL,
        json!({"artifact_id": id, "sheet": "data", "rows": [[2, {"formula": "=A3*2"}], [3, {"formula": "=A4*2"}]]}),
    )
    .await;
    assert!(!is_error, "{out}");
    assert_eq!(
        out["sheets"],
        json!([{"name": "Data", "rows": 4, "cols": 2}])
    );

    // Unknown sheet: the error lists the real ones.
    let (out, is_error) = call(
        &env,
        APPEND_ROWS_TOOL,
        json!({"artifact_id": id, "sheet": "Nope", "rows": [[1]]}),
    )
    .await;
    assert!(is_error);
    assert!(
        out["error"].as_str().unwrap().contains("Sheets: Data"),
        "{out}"
    );
}

#[tokio::test]
async fn add_and_edit_sheet_keep_formulas_pointing_at_the_right_cells() {
    let env = env().await;
    let (out, _) = call(&env, CREATE_SPREADSHEET_TOOL, menu_board()).await;
    let id = out["artifact_id"].as_str().unwrap().to_string();

    let (out, is_error) = call(
        &env,
        ADD_SHEET_TOOL,
        json!({"artifact_id": id, "name": "Summary", "position": 0,
               "rows": [["Total", {"formula": "=BOM!B4", "format": "currency"}]]}),
    )
    .await;
    assert!(!is_error, "{out}");
    assert_eq!(out["sheets"][0]["name"], "Summary");

    let (out, is_error) = call(
        &env,
        EDIT_SHEET_TOOL,
        json!({"artifact_id": id, "sheet": "Assumptions", "rename_to": "Inputs"}),
    )
    .await;
    assert!(!is_error, "{out}");
    assert_eq!(out["errors"], json!([]));

    let (out, is_error) = call(
        &env,
        EDIT_SHEET_TOOL,
        json!({"artifact_id": id, "sheet": "BOM", "insert_rows": {"at": 3, "rows": [["Shipping", 50]]}}),
    )
    .await;
    assert!(!is_error, "{out}");
    assert_eq!(out["errors"], json!([]));

    let (read, _) = call(
        &env,
        READ_SPREADSHEET_TOOL,
        json!({"artifact_id": id, "sheet": "Summary"}),
    )
    .await;
    // The summary still points at the total, now in row 5: 700 + 50 + 70.
    let total = &read["cells"][1];
    assert_eq!(total["formula"], "=BOM!B5");
    assert_eq!(total["display"], "$820.00");
    assert_eq!(read["sheets"].as_array().unwrap().len(), 3);

    let (out, is_error) = call(
        &env,
        EDIT_SHEET_TOOL,
        json!({"artifact_id": id, "sheet": "BOM", "delete_rows": {"from": 0, "count": 1}}),
    )
    .await;
    assert!(is_error, "{out}");
}

#[tokio::test]
async fn read_spreadsheet_caps_large_sheets_and_reads_ranges() {
    let env = env().await;
    let rows: Vec<Value> = (1..=100)
        .map(|i| json!([i, {"formula": format!("=A{i}*2")}]))
        .collect();
    let (out, _) = call(
        &env,
        CREATE_SPREADSHEET_TOOL,
        json!({"title": "big", "sheets": [{"name": "Big", "rows": rows}]}),
    )
    .await;
    let id = out["artifact_id"].as_str().unwrap().to_string();

    let (read, _) = call(&env, READ_SPREADSHEET_TOOL, json!({"artifact_id": id})).await;
    assert_eq!(read["truncated"], true);
    assert_eq!(read["cells"].as_array().unwrap().len(), 80);
    assert_eq!(read["range"], "A1:B40");
    assert!(
        read["note"].as_str().unwrap().contains("A41:B100"),
        "{read}"
    );

    let (read, _) = call(
        &env,
        READ_SPREADSHEET_TOOL,
        json!({"artifact_id": id, "range": "A41:B100"}),
    )
    .await;
    // 120 filled cells fit under the 400 cap.
    assert_eq!(read["cells"].as_array().unwrap().len(), 120);
    assert!(read.get("truncated").is_none());

    let (read, is_error) = call(
        &env,
        READ_SPREADSHEET_TOOL,
        json!({"artifact_id": id, "range": "zz"}),
    )
    .await;
    assert!(is_error, "{read}");
}

#[tokio::test]
async fn sheet_tools_refuse_other_kinds_of_artifact() {
    let env = env().await;
    let (out, _) = call(
        &env,
        WRITE_HTML_TOOL,
        json!({"title": "p", "html": "<p>x</p>"}),
    )
    .await;
    let id = out["artifact_id"].as_str().unwrap().to_string();
    let (out, is_error) = call(
        &env,
        APPEND_ROWS_TOOL,
        json!({"artifact_id": id, "sheet": "S", "rows": [[1]]}),
    )
    .await;
    assert!(is_error);
    assert!(
        out["error"].as_str().unwrap().contains("not 'spreadsheet'"),
        "{out}"
    );
}
