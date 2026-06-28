//! Phase 4 M4.5: `tool_calls` / `tool_results` persistence.
//!
//! MCP tool results are **not** provider `ProviderEvent`s, so the Phase 4
//! runtime writes `tool_calls` + `tool_results` rows directly here, in its own
//! statement. The Phase 3 `view == fold(events)` invariant stays scoped to
//! provider streaming; this table is the separate, explicit record of MCP tool
//! execution that the §6 trust-boundary rules require (tool output is untrusted
//! data, stored redacted, never re-injected into prompts without validation).
//!
//! `tool_results.content` is redacted via `mcp_runtime::redact` *before* it
//! reaches this module. Column-level encryption of `tool_results.content` is
//! deferred to M6.1 (migration 0004 added the `enc_key_version` column for that
//! purpose); this repo threads `&Encryption` through the write path now so M6.1
//! is a tier flip, not a schema change (mirrors the `licenses`/`tenant_cache`
//! repo pattern).

use provider_core::schema::{ToolCallRecord, ToolCallStatus};
use sqlx::{SqlitePool, Transaction};
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

/// Row shape for [`get_tool_call`] (the `tool_calls` columns we read back).
type ToolCallRecordRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Map a `ToolCallStatus` to its stored TEXT form. The schema enum serializes
/// camelCase (`pending`/`approved`/...); we mirror that here so reads and writes
/// agree without depending on serde at the sqlx bind boundary.
pub fn status_str(s: &ToolCallStatus) -> &'static str {
    match s {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::Approved => "approved",
        ToolCallStatus::Running => "running",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
        ToolCallStatus::Cancelled => "cancelled",
    }
}

/// Parse a stored status string back into the enum. Unknown values map to
/// `Pending` (the safest non-terminal default) so a future status added to the
/// enum never panics a read path.
pub fn parse_status(s: &str) -> ToolCallStatus {
    match s {
        "approved" => ToolCallStatus::Approved,
        "running" => ToolCallStatus::Running,
        "completed" => ToolCallStatus::Completed,
        "failed" => ToolCallStatus::Failed,
        "cancelled" => ToolCallStatus::Cancelled,
        _ => ToolCallStatus::Pending,
    }
}

/// Insert (or replace) a `tool_calls` row from a `ToolCallRecord`. Used to
/// record the call at `Pending`/`Running` and again after a status transition.
/// `message_id` is not on the record (the view folds it later) so it is left
/// NULL here.
pub async fn insert_tool_call(pool: &SqlitePool, rec: &ToolCallRecord) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO tool_calls \
         (id, tool_id, request_id, message_id, status, arguments, result, error, \
          approved_at, completed_at, created_at) \
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
            status=excluded.status, arguments=excluded.arguments, \
            result=excluded.result, error=excluded.error, \
            approved_at=COALESCE(excluded.approved_at, tool_calls.approved_at), \
            completed_at=excluded.completed_at",
    )
    .bind(&rec.id)
    .bind(&rec.tool_id)
    .bind(&rec.request_id)
    .bind(status_str(&rec.status))
    .bind(rec.arguments.as_ref().map(|v| v.to_string()))
    .bind(rec.result.as_ref().map(|v| v.to_string()))
    .bind(rec.error.as_ref())
    .bind(rec.approved_at.as_ref())
    .bind(rec.completed_at.as_ref())
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

/// Transition a tool call's status, optionally recording an error and/or the
/// completion timestamp. `approved_at` is set only when the new status is
/// `Approved` (and not already set).
pub async fn update_tool_call_status(
    pool: &SqlitePool,
    id: &str,
    status: ToolCallStatus,
    error: Option<&str>,
) -> Result<(), DbError> {
    let completed_at = matches!(
        status,
        ToolCallStatus::Completed | ToolCallStatus::Failed | ToolCallStatus::Cancelled
    );
    let approved_at = matches!(status, ToolCallStatus::Approved);
    sqlx::query(
        "UPDATE tool_calls SET \
            status = ?, \
            error = COALESCE(?, error), \
            completed_at = COALESCE(completed_at, CASE WHEN ? THEN ? ELSE NULL END), \
            approved_at = COALESCE(approved_at, CASE WHEN ? THEN ? ELSE NULL END) \
         WHERE id = ?",
    )
    .bind(status_str(&status))
    .bind(error)
    .bind(completed_at)
    .bind(now_iso8601())
    .bind(approved_at)
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Append a redacted tool-result content row for a tool call. `content` must
/// already be redacted by the caller (the execution path runs
/// `mcp_runtime::redact`). Threads `&Encryption` so M6.1 can encrypt
/// `tool_results.content` with no schema change.
pub async fn insert_tool_result(
    pool: &SqlitePool,
    enc: &Encryption,
    tool_call_id: &str,
    content: &serde_json::Value,
    is_error: bool,
) -> Result<String, DbError> {
    let id = Uuid::new_v4().to_string();
    let stored = enc.encrypt(&content.to_string())?;
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO tool_results \
         (id, tool_call_id, content, is_error, enc_key_version, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(tool_call_id)
    .bind(&stored)
    .bind(is_error as i64)
    .bind(enc_key_version)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(id)
}

/// List all tool calls for a given `request_id`, ordered by `created_at ASC`.
/// Used by `build_continuation_request()` to load tool calls from the
/// just-completed round and look up their results.
pub async fn list_tool_calls_by_request(
    pool: &SqlitePool,
    request_id: &str,
) -> Result<Vec<ToolCallRecord>, DbError> {
    let rows: Vec<ToolCallRecordRow> = sqlx::query_as(
        "SELECT id, tool_id, request_id, status, arguments, result, error,
                approved_at, completed_at
         FROM tool_calls WHERE request_id = ? ORDER BY created_at ASC",
    )
    .bind(request_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(
            |(
                id,
                tool_id,
                request_id,
                status,
                arguments,
                result,
                error,
                approved_at,
                completed_at,
            )| {
                Ok(ToolCallRecord {
                    id,
                    tool_id,
                    request_id,
                    status: parse_status(&status),
                    arguments: arguments.and_then(|s| serde_json::from_str(&s).ok()),
                    result: result.and_then(|s| serde_json::from_str(&s).ok()),
                    error,
                    approved_at,
                    completed_at,
                })
            },
        )
        .collect()
}

/// Read a tool call by id (used by the no-reinjection invariant test + future
/// UI reads). `result` is decrypted if the encryption tier is on.
pub async fn get_tool_call(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<ToolCallRecord>, DbError> {
    let row: Option<ToolCallRecordRow> = sqlx::query_as(
        "SELECT id, tool_id, request_id, status, arguments, result, error, \
                approved_at, completed_at FROM tool_calls WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(id, tool_id, request_id, status, arguments, result, error, approved_at, completed_at)| {
            ToolCallRecord {
                id,
                tool_id,
                request_id,
                status: parse_status(&status),
                arguments: arguments.and_then(|s| serde_json::from_str(&s).ok()),
                result: result.and_then(|s| {
                    enc.decrypt(&s)
                        .ok()
                        .and_then(|p| serde_json::from_str(&p).ok())
                }),
                error,
                approved_at,
                completed_at,
            }
        },
    ))
}

/// Read the most recent redacted result content for a tool call (decrypted if
/// the tier is on). Used by the no-reinjection invariant test.
pub async fn latest_tool_result(
    pool: &SqlitePool,
    enc: &Encryption,
    tool_call_id: &str,
) -> Result<Option<(serde_json::Value, bool)>, DbError> {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT content, is_error FROM tool_results \
         WHERE tool_call_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(tool_call_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(content, is_error)| {
        enc.decrypt(&content)
            .ok()
            .and_then(|p| serde_json::from_str(&p).ok())
            .map(|v| (v, is_error != 0))
    }))
}

/// Append a tool-result row inside an existing transaction (for tests that
/// want to compose writes). Not used by the execution path itself, which writes
/// results after the call completes.
#[allow(dead_code)]
pub(crate) async fn insert_tool_result_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    enc: &Encryption,
    tool_call_id: &str,
    content: &serde_json::Value,
    is_error: bool,
) -> Result<String, DbError> {
    let id = Uuid::new_v4().to_string();
    let stored = enc.encrypt(&content.to_string())?;
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO tool_results \
         (id, tool_call_id, content, is_error, enc_key_version, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(tool_call_id)
    .bind(&stored)
    .bind(is_error as i64)
    .bind(enc_key_version)
    .bind(now_iso8601())
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repository::connectors as conn_repo;
    use provider_core::schema::ToolCallStatus;
    use serde_json::json;

    #[tokio::test]
    async fn tool_call_round_trips_and_transitions() {
        let pool = crate::db::tests::pool().await;
        let enc = Encryption::off();
        let rec = ToolCallRecord {
            id: "tc-1".into(),
            tool_id: "echo".into(),
            request_id: "req-1".into(),
            status: ToolCallStatus::Running,
            arguments: Some(json!({ "text": "hi" })),
            result: None,
            error: None,
            approved_at: None,
            completed_at: None,
        };
        insert_tool_call(&pool, &rec).await.unwrap();
        // Transition to completed with a result row.
        update_tool_call_status(&pool, "tc-1", ToolCallStatus::Completed, None)
            .await
            .unwrap();
        insert_tool_result(&pool, &enc, "tc-1", &json!({ "echo": "hi" }), false)
            .await
            .unwrap();

        let got = get_tool_call(&pool, &enc, "tc-1").await.unwrap().unwrap();
        assert_eq!(got.status, ToolCallStatus::Completed);
        assert_eq!(got.arguments, Some(json!({ "text": "hi" })));
        assert!(got.completed_at.is_some());

        let (result, is_error) = latest_tool_result(&pool, &enc, "tc-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, json!({ "echo": "hi" }));
        assert!(!is_error);
    }

    #[tokio::test]
    async fn failed_status_records_error() {
        let pool = crate::db::tests::pool().await;
        let enc = Encryption::off();
        let rec = ToolCallRecord {
            id: "tc-2".into(),
            tool_id: "slow".into(),
            request_id: "req-2".into(),
            status: ToolCallStatus::Running,
            arguments: None,
            result: None,
            error: None,
            approved_at: None,
            completed_at: None,
        };
        insert_tool_call(&pool, &rec).await.unwrap();
        update_tool_call_status(
            &pool,
            "tc-2",
            ToolCallStatus::Failed,
            Some("tool exceeded the 30s call timeout"),
        )
        .await
        .unwrap();
        let got = get_tool_call(&pool, &enc, "tc-2").await.unwrap().unwrap();
        assert_eq!(got.status, ToolCallStatus::Failed);
        assert!(got.error.as_deref().unwrap().contains("timeout"));
    }

    #[tokio::test]
    async fn cancelled_status_records_denial() {
        let pool = crate::db::tests::pool().await;
        let enc = Encryption::off();
        let rec = ToolCallRecord {
            id: "tc-3".into(),
            tool_id: "post".into(),
            request_id: "req-3".into(),
            status: ToolCallStatus::Pending,
            arguments: Some(json!({ "channel": "general" })),
            result: None,
            error: None,
            approved_at: None,
            completed_at: None,
        };
        insert_tool_call(&pool, &rec).await.unwrap();
        update_tool_call_status(
            &pool,
            "tc-3",
            ToolCallStatus::Cancelled,
            Some("user denied consent"),
        )
        .await
        .unwrap();
        let got = get_tool_call(&pool, &enc, "tc-3").await.unwrap().unwrap();
        assert_eq!(got.status, ToolCallStatus::Cancelled);
        assert_eq!(got.error.as_deref(), Some("user denied consent"));
    }

    #[tokio::test]
    async fn approved_status_stamps_approved_at() {
        let pool = crate::db::tests::pool().await;
        let enc = Encryption::off();
        let rec = ToolCallRecord {
            id: "tc-4".into(),
            tool_id: "post".into(),
            request_id: "req-4".into(),
            status: ToolCallStatus::Pending,
            arguments: None,
            result: None,
            error: None,
            approved_at: None,
            completed_at: None,
        };
        insert_tool_call(&pool, &rec).await.unwrap();
        update_tool_call_status(&pool, "tc-4", ToolCallStatus::Approved, None)
            .await
            .unwrap();
        let got = get_tool_call(&pool, &enc, "tc-4").await.unwrap().unwrap();
        assert_eq!(got.status, ToolCallStatus::Approved);
        assert!(got.approved_at.is_some());
    }

    #[tokio::test]
    async fn list_tool_calls_by_request_returns_ordered_results() {
        let pool = crate::db::tests::pool().await;
        // Insert three tool calls with the same request_id.
        for i in 0..3 {
            let rec = ToolCallRecord {
                id: format!("tc-list-{i}"),
                tool_id: "echo".into(),
                request_id: "req-list".into(),
                status: ToolCallStatus::Completed,
                arguments: Some(json!({ "i": i })),
                result: None,
                error: None,
                approved_at: None,
                completed_at: None,
            };
            insert_tool_call(&pool, &rec).await.unwrap();
        }

        let rows = list_tool_calls_by_request(&pool, "req-list").await.unwrap();
        assert_eq!(rows.len(), 3);
        // Should be ordered by created_at ASC — the IDs should be in insertion order.
        assert_eq!(rows[0].id, "tc-list-0");
        assert_eq!(rows[1].id, "tc-list-1");
        assert_eq!(rows[2].id, "tc-list-2");

        // A different request_id should return empty.
        let empty = list_tool_calls_by_request(&pool, "req-other")
            .await
            .unwrap();
        assert!(empty.is_empty());
    }

    #[tokio::test]
    async fn get_capability_by_name_resolves_cached_tool() {
        let pool = crate::db::tests::pool().await;
        // Seed a definition + version so the capability row has a home (the
        // connector_capabilities table FKs connector_versions).
        let def = conn_repo::ConnectorDefinition {
            id: "echo".into(),
            name: "Echo".into(),
            description: "echo".into(),
            transport: "stdio".into(),
            owner: "test".into(),
            icon: None,
            support_url: None,
            consent_copy: None,
            policy_metadata: None,
            cloud_id: None,
            created_at: "2026-06-22T00:00:00Z".into(),
            updated_at: "2026-06-22T00:00:00Z".into(),
        };
        conn_repo::upsert_definition(&pool, &def).await.unwrap();
        let version = conn_repo::ConnectorVersion {
            id: "echo:1".into(),
            connector_id: "echo".into(),
            version: "1.0.0".into(),
            transport_config: json!({ "command": "echo", "args": [], "env": {} }),
            scope_grants: None,
            capability_allowlist: None,
            rollout_channel: None,
            support_state: None,
            created_at: "2026-06-22T00:00:00Z".into(),
        };
        conn_repo::insert_version(&pool, &version).await.unwrap();
        let caps = vec![
            conn_repo::new_capability("echo:1", "tool", "echo", Some(json!({}))),
            conn_repo::new_capability("echo:1", "tool", "post", None),
        ];
        conn_repo::upsert_capabilities(&pool, "echo:1", &caps)
            .await
            .unwrap();

        let got = conn_repo::get_capability_by_name(&pool, "echo:1", "post")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.name, "post");
        assert_eq!(got.kind, "tool");
        let missing = conn_repo::get_capability_by_name(&pool, "echo:1", "nope")
            .await
            .unwrap();
        assert!(missing.is_none());
    }
}
