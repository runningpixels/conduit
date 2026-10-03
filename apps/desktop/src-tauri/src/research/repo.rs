//! `research_runs`, `research_sources`, `research_claims`.
//!
//! The brief, summary, unanswered list, page text and claim/quote text are
//! encrypted at rest like other content columns (identity when encryption is
//! off). Counters, statuses, addresses and titles are not.

use std::collections::{HashMap, HashSet};

use provider_core::schema::{
    ResearchBrief, ResearchBudget, ResearchDepth, ResearchProgress, ResearchRun, ResearchSource,
    ResearchSourceStatus, ResearchStatus,
};
use sqlx::SqlitePool;

use super::run::{ClaimRecord, SourceRecord};
use crate::db::DbError;
use crate::encryption::Encryption;
use crate::time::now_iso8601;

/// A run's row, with the columns the card doesn't show.
#[derive(Debug, Clone)]
pub struct RunRow {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub hidden_conversation_id: Option<String>,
    pub status: ResearchStatus,
    pub brief: Option<ResearchBrief>,
    pub budget: ResearchBudget,
    pub progress: ResearchProgress,
    pub artifact_id: Option<String>,
    pub summary: Option<String>,
    pub unanswered: Vec<String>,
    pub unverified_dropped: u32,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

type Row = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    String,
    Option<String>,
);

const COLUMNS: &str =
    "id, conversation_id, message_id, hidden_conversation_id, status, brief_json, \
     budget_json, progress_json, artifact_id, summary, unanswered_json, unverified_dropped, error, \
     created_at, finished_at";

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, DbError> {
    serde_json::to_string(value).map_err(|e| DbError::Query(e.to_string()))
}

/// Create a run in `planning`, with Standard's budget until a brief exists.
pub async fn create_run(
    pool: &SqlitePool,
    id: &str,
    conversation_id: &str,
    message_id: &str,
    hidden_conversation_id: &str,
) -> Result<(), DbError> {
    let depth = ResearchDepth::Standard;
    let budget = depth.budget();
    let progress = ResearchProgress {
        searches_limit: budget.searches,
        pages_limit: budget.pages,
        ..Default::default()
    };
    sqlx::query(
        "INSERT INTO research_runs (id, conversation_id, message_id, hidden_conversation_id, \
         status, depth, budget_json, progress_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(conversation_id)
    .bind(message_id)
    .bind(hidden_conversation_id)
    .bind(ResearchStatus::Planning.as_str())
    .bind(depth.as_str())
    .bind(to_json(&budget)?)
    .bind(to_json(&progress)?)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

/// Store a brief (planned or approved), its depth's budget and fresh
/// progress, and move the run to `status`.
pub async fn set_brief(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    brief: &ResearchBrief,
    status: ResearchStatus,
) -> Result<(), DbError> {
    let budget = brief.depth.budget();
    let progress = ResearchProgress {
        searches_limit: budget.searches,
        pages_limit: budget.pages,
        ..Default::default()
    };
    sqlx::query(
        "UPDATE research_runs SET brief_json = ?, depth = ?, budget_json = ?, progress_json = ?, \
         status = ? WHERE id = ?",
    )
    .bind(enc.encrypt(&to_json(brief)?)?)
    .bind(brief.depth.as_str())
    .bind(to_json(&budget)?)
    .bind(to_json(&progress)?)
    .bind(status.as_str())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Move a run from one of `from` to `to`; `false` when it wasn't in one of
/// them (someone else moved it first). A finished status also sets
/// `finished_at` and `error`.
pub async fn transition(
    pool: &SqlitePool,
    id: &str,
    from: &[ResearchStatus],
    to: ResearchStatus,
    error: Option<&str>,
) -> Result<bool, DbError> {
    let placeholders = vec!["?"; from.len()].join(", ");
    let sql = format!(
        "UPDATE research_runs SET status = ?, error = COALESCE(?, error), \
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END \
         WHERE id = ? AND status IN ({placeholders})"
    );
    let mut query = sqlx::query(&sql)
        .bind(to.as_str())
        .bind(error)
        .bind(to.is_finished())
        .bind(now_iso8601())
        .bind(id);
    for status in from {
        query = query.bind(status.as_str());
    }
    Ok(query.execute(pool).await?.rows_affected() > 0)
}

pub async fn set_progress(
    pool: &SqlitePool,
    id: &str,
    progress: &ResearchProgress,
) -> Result<(), DbError> {
    sqlx::query("UPDATE research_runs SET progress_json = ? WHERE id = ?")
        .bind(to_json(progress)?)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// How a run ended.
pub struct Finish<'a> {
    pub status: ResearchStatus,
    pub artifact_id: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub unanswered: &'a [String],
    pub unverified_dropped: u32,
    pub error: Option<&'a str>,
    pub progress: &'a ResearchProgress,
}

pub async fn finish(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    end: &Finish<'_>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE research_runs SET status = ?, artifact_id = ?, summary = ?, unanswered_json = ?, \
         unverified_dropped = ?, error = ?, progress_json = ?, finished_at = ? WHERE id = ?",
    )
    .bind(end.status.as_str())
    .bind(end.artifact_id)
    .bind(enc.encrypt_opt(end.summary)?)
    .bind(enc.encrypt(&to_json(&end.unanswered)?)?)
    .bind(i64::from(end.unverified_dropped))
    .bind(end.error)
    .bind(to_json(end.progress)?)
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Store a run's sources and claims, with each source's citation number and which
/// claims the report cites. One transaction.
pub async fn save_results(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
    sources: &[SourceRecord],
    claims: &[ClaimRecord],
    footnotes: &HashMap<String, u32>,
    used: &HashSet<String>,
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    for s in sources {
        let text = (!s.text.is_empty()).then_some(s.text.as_str());
        sqlx::query(
            "INSERT INTO research_sources (id, run_id, url, final_url, title, host, fetched_at, \
             content_hash, text, status, footnote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&s.id)
        .bind(run_id)
        .bind(&s.url)
        .bind(&s.final_url)
        .bind(&s.title)
        .bind(&s.host)
        .bind(&s.fetched_at)
        .bind(&s.content_hash)
        .bind(enc.encrypt_opt(text)?)
        .bind(s.status.as_str())
        .bind(footnotes.get(&s.id).map(|k| i64::from(*k)))
        .execute(&mut *tx)
        .await?;
    }
    for c in claims {
        sqlx::query(
            "INSERT INTO research_claims (id, run_id, sub_question, claim, quote, source_id, \
             verified, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&c.id)
        .bind(run_id)
        .bind(c.sub_question as i64)
        .bind(enc.encrypt(&c.claim)?)
        .bind(enc.encrypt(&c.quote)?)
        .bind(&c.source_id)
        .bind(c.verified)
        .bind(used.contains(&c.id))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn from_row(enc: &Encryption, row: Row) -> Result<RunRow, DbError> {
    let (
        id,
        conversation_id,
        message_id,
        hidden_conversation_id,
        status,
        brief_json,
        budget_json,
        progress_json,
        artifact_id,
        summary,
        unanswered_json,
        unverified_dropped,
        error,
        created_at,
        finished_at,
    ) = row;
    let brief = match brief_json {
        Some(stored) => serde_json::from_str(&enc.decrypt(&stored)?).ok(),
        None => None,
    };
    let unanswered = match unanswered_json {
        Some(stored) => serde_json::from_str(&enc.decrypt(&stored)?).unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(RunRow {
        id,
        conversation_id,
        message_id,
        hidden_conversation_id,
        status: ResearchStatus::parse(&status).unwrap_or(ResearchStatus::Failed),
        brief,
        budget: serde_json::from_str(&budget_json)
            .unwrap_or_else(|_| ResearchDepth::Standard.budget()),
        progress: serde_json::from_str(&progress_json).unwrap_or_default(),
        artifact_id,
        summary: enc.decrypt_opt(summary.as_deref())?,
        unanswered,
        unverified_dropped: u32::try_from(unverified_dropped.max(0)).unwrap_or(u32::MAX),
        error,
        created_at,
        finished_at,
    })
}

pub async fn get_row(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<RunRow>, DbError> {
    let row: Option<Row> =
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM research_runs WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
    row.map(|r| from_row(enc, r)).transpose()
}

type SourceRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<i64>,
    i64,
);

/// A run's sources, cited ones first in citation order, then in the order
/// they were read.
pub async fn list_sources(pool: &SqlitePool, run_id: &str) -> Result<Vec<ResearchSource>, DbError> {
    let rows: Vec<SourceRow> = sqlx::query_as(
        "SELECT s.id, s.url, s.final_url, s.title, s.host, s.fetched_at, s.status, s.footnote, \
         (SELECT COUNT(*) FROM research_claims c WHERE c.source_id = s.id AND c.verified = 1) \
         FROM research_sources s WHERE s.run_id = ? \
         ORDER BY s.footnote IS NULL, s.footnote, s.fetched_at, s.rowid",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, url, final_url, title, host, fetched_at, status, footnote, claims)| {
                ResearchSource {
                    id,
                    url: final_url.unwrap_or(url),
                    title,
                    host,
                    fetched_at,
                    status: ResearchSourceStatus::parse(&status),
                    claims: u32::try_from(claims.max(0)).unwrap_or(u32::MAX),
                    footnote: footnote.and_then(|k| u32::try_from(k).ok()),
                }
            },
        )
        .collect())
}

/// The run as the card shows it.
pub async fn get_run(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<ResearchRun>, DbError> {
    let Some(row) = get_row(pool, enc, id).await? else {
        return Ok(None);
    };
    let sources = list_sources(pool, id).await?;
    Ok(Some(ResearchRun {
        id: row.id,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        status: row.status,
        brief: row.brief,
        budget: row.budget,
        progress: row.progress,
        artifact_id: row.artifact_id,
        summary: row.summary,
        sources,
        unanswered: row.unanswered,
        unverified_dropped: row.unverified_dropped,
        error: row.error,
        created_at: row.created_at,
        finished_at: row.finished_at,
    }))
}

/// Text stored for a source (decrypted), for re-checking quotes.
pub async fn source_text(
    pool: &SqlitePool,
    enc: &Encryption,
    source_id: &str,
) -> Result<Option<String>, DbError> {
    let stored: Option<Option<String>> =
        sqlx::query_scalar("SELECT text FROM research_sources WHERE id = ?")
            .bind(source_id)
            .fetch_optional(pool)
            .await?;
    enc.decrypt_opt(stored.flatten().as_deref())
}

/// Mark runs left `planning` or `running` as failed: at launch nothing runs,
/// so the app closed before they finished. Returns how many.
pub async fn fail_interrupted(pool: &SqlitePool) -> Result<u64, DbError> {
    let error = format!(
        "{} closed before this research finished.",
        crate::brand::app_name()
    );
    let done = sqlx::query(
        "UPDATE research_runs SET status = ?, error = ?, finished_at = ? \
         WHERE status IN (?, ?)",
    )
    .bind(ResearchStatus::Failed.as_str())
    .bind(&error)
    .bind(now_iso8601())
    .bind(ResearchStatus::Planning.as_str())
    .bind(ResearchStatus::Running.as_str())
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}
