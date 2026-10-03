//! What the research commands do, without Tauri: start a run in a chat, plan
//! it, approve its brief, run it and save what it found, stop or cancel it.
//! `commands::research` wires these to IPC and background tasks; tests call
//! them directly.

use std::time::Duration;

use chrono::Utc;
use provider_core::schema::{
    Message, MessagePart, MessagePartKind, MessageRole, ResearchBrief, ResearchProgress,
    ResearchRun, ResearchStatus,
};
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::run::{Engine, StopReason};
use super::{brief, clip, one_line, repo, ResearchIo, ResearchRuns};
use crate::db::repository::artifacts::{self, ArtifactContent};
use crate::db::repository::{conversations, messages};
use crate::state::{AppSettings, AppState};
use crate::workflows::scheduler::to_iso;

/// Hears a run's status after each change: `(run_id, status)`.
pub type Notify<'a> = dyn Fn(&str, ResearchStatus) + Send + Sync + 'a;

/// Fewest milliseconds between two progress saves (and events).
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// Longest title for the chat and the report.
const TITLE_CHARS: usize = 60;
const REPORT_TITLE_CHARS: usize = 120;

/// Why research can't run with these settings, if it can't.
pub fn availability(settings: &AppSettings) -> Result<(), String> {
    if settings.local_only {
        return Err(
            "Research isn't available in local-only mode: it searches and reads the web."
                .to_string(),
        );
    }
    if !(settings.web_search_enabled && settings.web_search_consent_acknowledged) {
        return Err(
            "Research needs web search. Turn on web search in Settings → Web search first."
                .to_string(),
        );
    }
    Ok(())
}

fn db(e: crate::db::DbError) -> String {
    e.to_string()
}

fn text_message(
    id: &str,
    conversation_id: &str,
    role: MessageRole,
    text: &str,
    metadata: Option<serde_json::Value>,
    created_at: &str,
) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata,
        parts: vec![MessagePart {
            id: format!("{id}/p0"),
            message_id: id.to_string(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(text.to_string()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: created_at.to_string(),
        }],
        created_at: created_at.to_string(),
    }
}

/// Start a run in `conversation_id` for `question`: save the user's message
/// and the assistant message the run's card lives on, name the chat if it
/// has no name yet, and create the run (`planning`) with its hidden
/// conversation. Planning itself is [`plan_run`], in the background.
pub async fn start(
    state: &AppState,
    conversation_id: &str,
    question: &str,
) -> Result<ResearchRun, String> {
    availability(&state.settings()?)?;
    let question = question.trim();
    if question.is_empty() {
        return Err("Ask a question to research.".to_string());
    }
    if question.chars().count() > brief::MAX_QUESTION_CHARS {
        return Err(format!(
            "Keep the question under {} characters.",
            brief::MAX_QUESTION_CHARS
        ));
    }
    let pool = &state.db;
    // Like a chat turn: the renderer may name a chat it hasn't saved yet.
    conversations::ensure_exists(pool, conversation_id)
        .await
        .map_err(db)?;
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    if kind.as_deref() != Some("chat") {
        return Err("Research runs in a chat.".to_string());
    }
    let had_user_message: Option<String> = sqlx::query_scalar(
        "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let run_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let user_at = to_iso(now);
    // A millisecond later, so history order is certain.
    let assistant_at = to_iso(now + chrono::Duration::milliseconds(1));
    let user = text_message(
        &Uuid::new_v4().to_string(),
        conversation_id,
        MessageRole::User,
        question,
        None,
        &user_at,
    );
    let assistant_id = Uuid::new_v4().to_string();
    let assistant = text_message(
        &assistant_id,
        conversation_id,
        MessageRole::Assistant,
        "",
        Some(json!({ "researchRunId": run_id })),
        &assistant_at,
    );
    messages::insert_message(pool, &user).await.map_err(db)?;
    messages::insert_message(pool, &assistant)
        .await
        .map_err(db)?;
    // The card's message is complete as it stands; the run fills its text.
    sqlx::query("UPDATE messages SET finalized = 1 WHERE id = ?")
        .bind(&assistant_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Same as a chat's first message: an unnamed chat is named after it.
    let titled = conversations::get(pool, conversation_id)
        .await
        .map_err(db)?
        .and_then(|c| c.title)
        .is_some_and(|t| !t.trim().is_empty());
    if !titled && had_user_message.is_none() {
        if let Some(title) = conversations::resolve_display_title(None, Some(question)) {
            conversations::set_title(pool, conversation_id, &title)
                .await
                .map_err(db)?;
        }
    }
    conversations::touch(pool, conversation_id)
        .await
        .map_err(db)?;

    let hidden = conversations::create(pool, Some(&clip(&one_line(question), TITLE_CHARS)))
        .await
        .map_err(db)?;
    conversations::set_kind(pool, &hidden.id, "automation")
        .await
        .map_err(db)?;
    repo::create_run(pool, &run_id, conversation_id, &assistant_id, &hidden.id)
        .await
        .map_err(db)?;
    get(state, &run_id).await
}

/// The run, as the card shows it.
pub async fn get(state: &AppState, run_id: &str) -> Result<ResearchRun, String> {
    repo::get_run(&state.db, &state.encryption, run_id)
        .await
        .map_err(db)?
        .ok_or_else(|| "That research no longer exists.".to_string())
}

/// Plan a `planning` run: draft its brief and wait for the user's approval
/// (`awaitingApproval`). Stopping ends it as `stopped`; a failed model call
/// as `failed`.
pub async fn plan_run(
    state: &AppState,
    io: &dyn ResearchIo,
    run_id: &str,
    question: &str,
    stop: &CancellationToken,
    notify: &Notify<'_>,
) {
    let pool = &state.db;
    let planned = if stop.is_cancelled() {
        None
    } else {
        tokio::select! {
            biased;
            _ = stop.cancelled() => None,
            planned = brief::plan(io, question) => Some(planned),
        }
    };
    let status = match planned {
        Some(Ok(draft)) => {
            let current = repo::get_row(pool, &state.encryption, run_id).await;
            match current {
                Ok(Some(row)) if row.status == ResearchStatus::Planning => {
                    match repo::set_brief(
                        pool,
                        &state.encryption,
                        run_id,
                        &draft,
                        ResearchStatus::AwaitingApproval,
                    )
                    .await
                    {
                        Ok(()) => ResearchStatus::AwaitingApproval,
                        Err(e) => fail(state, run_id, &e.to_string()).await,
                    }
                }
                // Stopped meanwhile, or the chat was deleted.
                Ok(Some(row)) => row.status,
                Ok(None) => return,
                Err(e) => fail(state, run_id, &e.to_string()).await,
            }
        }
        Some(Err(e)) => fail(state, run_id, &e).await,
        None => {
            let _ = repo::transition(
                pool,
                run_id,
                &[ResearchStatus::Planning],
                ResearchStatus::Stopped,
                None,
            )
            .await;
            ResearchStatus::Stopped
        }
    };
    notify(run_id, status);
}

async fn fail(state: &AppState, run_id: &str, error: &str) -> ResearchStatus {
    tracing::warn!(%run_id, %error, "research run failed");
    let _ = repo::transition(
        &state.db,
        run_id,
        &[ResearchStatus::Planning, ResearchStatus::Running],
        ResearchStatus::Failed,
        Some(error),
    )
    .await;
    ResearchStatus::Failed
}

/// Approve `brief` (as the user edited it) for a run waiting on it: the run
/// is `running` when this returns; [`execute`] does the work.
pub async fn approve(
    state: &AppState,
    run_id: &str,
    brief: &ResearchBrief,
) -> Result<(ResearchRun, ResearchBrief), String> {
    availability(&state.settings()?)?;
    let brief = brief::checked(brief)?;
    let pool = &state.db;
    let row = repo::get_row(pool, &state.encryption, run_id)
        .await
        .map_err(db)?
        .ok_or_else(|| "That research no longer exists.".to_string())?;
    if row.status != ResearchStatus::AwaitingApproval {
        return Err(not_waiting(row.status));
    }
    if !repo::transition(
        pool,
        run_id,
        &[ResearchStatus::AwaitingApproval],
        ResearchStatus::Running,
        None,
    )
    .await
    .map_err(db)?
    {
        return Err("This research isn't waiting for approval any more.".to_string());
    }
    repo::set_brief(
        pool,
        &state.encryption,
        run_id,
        &brief,
        ResearchStatus::Running,
    )
    .await
    .map_err(db)?;
    Ok((get(state, run_id).await?, brief))
}

fn not_waiting(status: ResearchStatus) -> String {
    match status {
        ResearchStatus::Planning => "The brief isn't ready yet.".to_string(),
        ResearchStatus::Running => "This research is already running.".to_string(),
        _ => "This research has already ended.".to_string(),
    }
}

/// Run an approved brief to the end and save what it found: sources and
/// claims, the report (a Markdown document in the chat), the summary as the
/// assistant message's text, and the final status.
pub async fn execute(
    state: &AppState,
    io: &dyn ResearchIo,
    run_id: &str,
    brief: &ResearchBrief,
    stop: &CancellationToken,
    notify: &Notify<'_>,
) {
    let pool = &state.db;
    let row = match repo::get_row(pool, &state.encryption, run_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(e) => {
            let status = fail(state, run_id, &e.to_string()).await;
            notify(run_id, status);
            return;
        }
    };
    let (tx, mut rx) = watch::channel(ResearchProgress::default());
    let budget = row.budget;
    let work = async move {
        let send = move |p: &ResearchProgress| {
            tx.send_replace(p.clone());
        };
        let mut engine = Engine::new(io, stop.clone(), budget);
        engine.on_progress = Some(&send);
        engine.run(brief).await
    };
    // Progress is saved (and announced) at most every PROGRESS_EVERY.
    let pump = async {
        while rx.changed().await.is_ok() {
            let progress = rx.borrow_and_update().clone();
            if let Err(e) = repo::set_progress(pool, run_id, &progress).await {
                tracing::warn!(error = %e, "research: could not save progress");
            }
            notify(run_id, ResearchStatus::Running);
            tokio::time::sleep(PROGRESS_EVERY).await;
        }
    };
    let (outcome, ()) = tokio::join!(work, pump);

    let status = match (outcome.stop, &outcome.error) {
        (Some(StopReason::User), _) => ResearchStatus::Stopped,
        (_, Some(_)) => ResearchStatus::Failed,
        _ => ResearchStatus::Done,
    };
    let saved = save(state, &row, brief, &outcome, status).await;
    let status = match saved {
        Ok(()) => status,
        Err(e) => fail(state, run_id, &e).await,
    };
    notify(run_id, status);
}

async fn save(
    state: &AppState,
    row: &repo::RunRow,
    brief: &ResearchBrief,
    outcome: &super::run::Outcome,
    status: ResearchStatus,
) -> Result<(), String> {
    let pool = &state.db;
    let enc = &state.encryption;
    let empty_footnotes = Default::default();
    let empty_used = Default::default();
    let (footnotes, used) = match &outcome.report {
        Some(r) => (&r.footnotes, &r.used_claims),
        None => (&empty_footnotes, &empty_used),
    };
    repo::save_results(
        pool,
        enc,
        &row.id,
        &outcome.sources,
        &outcome.claims,
        footnotes,
        used,
    )
    .await
    .map_err(db)?;

    let mut artifact_id = None;
    if let Some(rendered) = &outcome.report {
        let title = clip(&one_line(&brief.question), REPORT_TITLE_CHARS);
        let artifact = artifacts::create(
            pool,
            &row.conversation_id,
            "markdown",
            Some(&title),
            Some(&row.message_id),
        )
        .await
        .map_err(db)?;
        artifacts::set_content(
            pool,
            &state.paths.artifacts,
            enc,
            &artifact.id,
            Some("text/markdown"),
            &ArtifactContent::Text {
                text: rendered.markdown.clone(),
            },
        )
        .await
        .map_err(db)?;
        // The summary, with the same [n] citations as the card and the
        // report, whose numbered Sources list they point into.
        let text = format!(
            "{}\n\nThe full report, with its sources, is in the document \u{201C}{title}\u{201D}.",
            rendered.summary
        );
        sqlx::query("UPDATE message_parts SET content = ? WHERE message_id = ? AND kind = 'text'")
            .bind(&text)
            .bind(&row.message_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        conversations::touch(pool, &row.conversation_id)
            .await
            .map_err(db)?;
        artifact_id = Some(artifact.id);
    }
    repo::finish(
        pool,
        enc,
        &row.id,
        &repo::Finish {
            status,
            artifact_id: artifact_id.as_deref(),
            summary: outcome.report.as_ref().map(|r| r.summary.as_str()),
            unanswered: &outcome.unanswered,
            unverified_dropped: outcome.unverified_dropped,
            error: outcome.error.as_deref(),
            progress: &outcome.progress,
        },
    )
    .await
    .map_err(db)
}

/// Stop a run after the step it is on (a partial report is written). A run
/// still waiting for approval is cancelled; one that has ended is left as is.
pub async fn stop(state: &AppState, runs: &ResearchRuns, run_id: &str) -> Result<(), String> {
    let row = repo::get_row(&state.db, &state.encryption, run_id)
        .await
        .map_err(db)?
        .ok_or_else(|| "That research no longer exists.".to_string())?;
    match row.status {
        ResearchStatus::AwaitingApproval => cancel(state, run_id).await,
        ResearchStatus::Planning | ResearchStatus::Running => {
            if !runs.stop(run_id) {
                // Nothing is working on it (it was cut off): end it here.
                repo::transition(
                    &state.db,
                    run_id,
                    &[ResearchStatus::Planning, ResearchStatus::Running],
                    ResearchStatus::Stopped,
                    None,
                )
                .await
                .map_err(db)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Cancel a run waiting for approval: it ends `stopped`, having done nothing.
pub async fn cancel(state: &AppState, run_id: &str) -> Result<(), String> {
    let pool = &state.db;
    if repo::transition(
        pool,
        run_id,
        &[ResearchStatus::AwaitingApproval],
        ResearchStatus::Stopped,
        None,
    )
    .await
    .map_err(db)?
    {
        return Ok(());
    }
    let row = repo::get_row(pool, &state.encryption, run_id)
        .await
        .map_err(db)?
        .ok_or_else(|| "That research no longer exists.".to_string())?;
    match row.status {
        ResearchStatus::Stopped => Ok(()),
        ResearchStatus::Planning => {
            Err("The brief isn't ready yet; stop the research instead.".to_string())
        }
        ResearchStatus::Running => {
            Err("This research has already started; stop it instead.".to_string())
        }
        _ => Err("This research has already ended.".to_string()),
    }
}
