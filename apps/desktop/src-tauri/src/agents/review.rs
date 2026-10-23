//! Reviewing a chat's document: the user's Reviewer agent reads it against
//! the request that produced it and lists what to change. The chat then makes
//! one revision (the frontend sends it), so the review itself changes nothing.
//!
//! The Reviewer is the library agent `reviewer`, with whatever the user made
//! of it; when they deleted it, the starter definition stands in.

use std::borrow::Cow;
use std::sync::atomic::AtomicUsize;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agents::handoff::{ChatHandoff, TURN_CEILING};
use crate::agents::library;
use crate::connector_runtime::ConnectorRuntimeManager;
use crate::db::repository::artifacts;
use crate::event_sink::EventSink;
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::workflows::definition::AgentDef;
use crate::workflows::runner::{cap_text, parse_json_reply};

/// The library agent that reviews.
pub const REVIEWER_ID: &str = "reviewer";

/// The kinds of artifact a review reads: the chat's documents.
pub const REVIEWABLE_KINDS: [&str; 3] = ["html", "markdown", "text"];

/// The most issues one review returns; the revision fixes them in one turn.
pub const MAX_ISSUES: usize = 10;

/// The longest document text the Reviewer is given.
const MAX_DOCUMENT_CHARS: usize = 60_000;
/// The longest request text it is given.
const MAX_REQUEST_CHARS: usize = 8_000;
/// The longest problem or change text kept from one issue.
const MAX_ISSUE_CHARS: usize = 2_000;

/// One thing the Reviewer found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewIssue {
    pub problem: String,
    /// What to change; empty when the Reviewer didn't say.
    #[serde(default)]
    pub change: String,
}

/// A review's outcome: no issues means the document meets the request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReview {
    /// The reviewing agent's name, for "Reviewed by …".
    pub reviewer: String,
    pub issues: Vec<ReviewIssue>,
}

/// The Reviewer: the user's, or the starter one when it was deleted.
pub fn reviewer(library: &std::collections::HashMap<String, AgentDef>) -> AgentDef {
    library.get(REVIEWER_ID).cloned().unwrap_or_else(|| {
        library::starters()
            .into_iter()
            .find(|a| a.id == REVIEWER_ID)
            .expect("the starter agents include the Reviewer")
    })
}

/// What the Reviewer is asked: the request, the document, and the answer's shape.
pub fn review_task(request: &str, kind: &str, title: &str, document: &str) -> String {
    let request = cap_text(request.trim(), MAX_REQUEST_CHARS);
    let document = cap_text(document.trim(), MAX_DOCUMENT_CHARS);
    let title = if title.trim().is_empty() {
        String::new()
    } else {
        format!(" titled \u{201c}{}\u{201d}", title.trim())
    };
    let against = if request.is_empty() {
        "The request that produced it isn't known: check that it is correct and complete on its own terms.".to_string()
    } else {
        format!(
            "Check it against the request that produced it: that it does everything the request asks \u{2014} every count, length limit, section and detail \u{2014} and that its facts are right.\n\nREQUEST:\n{request}"
        )
    };
    format!(
        "Review this document. It is already saved as a {kind} document{title}, so don't comment on its file format or whether it was saved. Look things up when you're unsure of a fact. Leave out matters of taste.\n\n{against}\n\nDOCUMENT:\n{document}\n\nAnswer with only this JSON, most important issue first:\n{{\"verdict\": \"ok\" or \"issues\", \"issues\": [{{\"problem\": \"what is wrong\", \"change\": \"what to change\"}}]}}\nUse \"ok\" with no issues when it fully meets the request."
    )
}

/// The issues in the Reviewer's answer. A JSON answer is read as asked; any
/// other answer is one issue holding its text, unless it says nothing needs
/// to change.
pub fn parse_review(answer: &str) -> Vec<ReviewIssue> {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Some(value) = parse_json_reply(trimmed) {
        if value["verdict"].as_str().map(str::trim) == Some("ok") {
            return Vec::new();
        }
        let items = match &value {
            Value::Array(items) => Some(items),
            _ => value["issues"].as_array(),
        };
        if let Some(items) = items {
            return items.iter().filter_map(issue_of).take(MAX_ISSUES).collect();
        }
    }
    if trimmed.to_lowercase().contains("no changes needed") {
        return Vec::new();
    }
    vec![ReviewIssue {
        problem: cap_text(trimmed, MAX_ISSUE_CHARS * 2),
        change: String::new(),
    }]
}

fn issue_of(item: &Value) -> Option<ReviewIssue> {
    let (problem, change) = match item {
        Value::String(text) => (text.as_str(), ""),
        Value::Object(_) => (
            item["problem"].as_str().unwrap_or_default(),
            item["change"].as_str().unwrap_or_default(),
        ),
        _ => return None,
    };
    let problem = cap_text(problem.trim(), MAX_ISSUE_CHARS);
    let change = cap_text(change.trim(), MAX_ISSUE_CHARS);
    if problem.is_empty() && change.is_empty() {
        return None;
    }
    Some(ReviewIssue { problem, change })
}

/// Review the document `artifact_id` against `request`, the user's words
/// that produced it (empty when unknown).
pub async fn review_document(
    state: &AppState,
    runtime: &ConnectorRuntimeManager,
    streams: &StreamManager,
    artifact_id: &str,
    request: &str,
) -> Result<DocumentReview, String> {
    let artifact = artifacts::get(&state.db, &state.encryption, artifact_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That document no longer exists.".to_string())?;
    if !REVIEWABLE_KINDS.contains(&artifact.kind.as_str()) {
        return Err("Only documents can be reviewed.".to_string());
    }
    let document = artifact.content_text.clone().unwrap_or_default();
    if document.trim().is_empty() {
        return Err("The document is empty.".to_string());
    }
    let library = library::load(&state.db, &state.encryption).await?;
    let agent = reviewer(&library);
    let task = review_task(
        request,
        &artifact.kind,
        artifact.title.as_deref().unwrap_or_default(),
        &document,
    );

    // Run as a helper with no chat turn around it: nothing listens to its
    // events, and its row stands alone.
    let handed = AtomicUsize::new(0);
    let handoff = ChatHandoff {
        state,
        runtime,
        streams,
        conversation_id: String::new(),
        request_id: Uuid::new_v4().to_string(),
        events: EventSink::discard(),
        runtime_events: EventSink::discard(),
        helpers: Cow::Owned(Vec::new()),
        offered: Vec::new(),
        chain: Vec::new(),
        lead_id: None,
        lead_name: "Review".to_string(),
        lead_row: None,
        handed: &handed,
        ceiling: Instant::now() + TURN_CEILING,
        top: false,
    };
    let answer = handoff
        .run_task(&agent, &task, &CancellationToken::new())
        .await?;
    Ok(DocumentReview {
        reviewer: agent.name.trim().to_string(),
        issues: parse_review(&answer),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_issues_it_was_asked_for() {
        let answer = r#"Here you go:
```json
{"verdict": "issues", "issues": [
  {"problem": "Over 600 words", "change": "Cut the summary"},
  {"problem": "", "change": ""},
  "Day 3 is not a rest day"
]}
```"#;
        assert_eq!(
            parse_review(answer),
            vec![
                ReviewIssue {
                    problem: "Over 600 words".into(),
                    change: "Cut the summary".into()
                },
                ReviewIssue {
                    problem: "Day 3 is not a rest day".into(),
                    change: String::new()
                },
            ]
        );
    }

    #[test]
    fn ok_means_nothing_to_change() {
        assert!(parse_review(r#"{"verdict":"ok","issues":[]}"#).is_empty());
        assert!(parse_review(r#"{"verdict":"ok","issues":[{"problem":"x"}]}"#).is_empty());
        assert!(parse_review("No changes needed. It covers everything.").is_empty());
        assert!(parse_review("  ").is_empty());
    }

    #[test]
    fn an_answer_that_isnt_json_is_one_issue() {
        let issues = parse_review("The table has 4 rows; the request asked for 3.");
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].problem,
            "The table has 4 rows; the request asked for 3."
        );
    }

    #[test]
    fn keeps_at_most_the_first_ten() {
        let many: Vec<String> = (0..15).map(|i| format!("\"issue {i}\"")).collect();
        let answer = format!("{{\"verdict\":\"issues\",\"issues\":[{}]}}", many.join(","));
        let issues = parse_review(&answer);
        assert_eq!(issues.len(), MAX_ISSUES);
        assert_eq!(issues[0].problem, "issue 0");
    }

    #[test]
    fn the_task_says_it_is_saved_and_carries_the_request() {
        let task = review_task("Under 200 words.", "markdown", "Heater", "Dear landlord");
        assert!(task.contains("already saved as a markdown document titled \u{201c}Heater\u{201d}"));
        assert!(task.contains("REQUEST:\nUnder 200 words."));
        assert!(task.contains("DOCUMENT:\nDear landlord"));
        let unknown = review_task("", "text", "", "Notes");
        assert!(unknown.contains("isn't known"));
        assert!(!unknown.contains("REQUEST:"));
    }

    #[test]
    fn the_starter_stands_in_for_a_deleted_reviewer() {
        let agent = reviewer(&Default::default());
        assert_eq!(agent.id, REVIEWER_ID);
        assert!(agent.tools.iter().any(|t| t == "web_search"));
    }
}
