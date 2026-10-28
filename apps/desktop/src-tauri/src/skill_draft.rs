//! Drafting an Agent Skill (a SKILL.md) from a chat: what the user asked and
//! which tools were used are replayed as a transcript, and the chat's model
//! writes a name, a description and instructions.
//!
//! The machinery is the workflow drafter's ([`crate::workflows::author`]): the
//! same transcript (never tool outputs or document text, secrets removed), the
//! same tool-less request recorded in the hidden drafting conversation, the
//! same time limit. A draft is never saved here; the user edits it and saves
//! it with [`save`].

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use provider_core::schema::MessageRole;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::db::repository::skills as skill_repo;
use crate::skills::{self, SkillSource, SkillSummary};
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::workflows::author;
use crate::workflows::runner::{parse_json_reply, JSON_REPAIR};

/// How long drafting may take, all model calls together.
pub const DRAFT_TIMEOUT: Duration = author::DRAFT_TIMEOUT;
/// How many times a bad reply is sent back for a fix.
pub const MAX_REPAIRS: u32 = 1;
const MAX_DESCRIPTION_CHARS: usize = 1024;

pub const NOTHING_USABLE: &str =
    "The model didn't return a usable skill. Try again, or try another model.";
const EMPTY_CHAT: &str = "That chat has no messages to make a skill from.";

const SYSTEM: &str = "You write Agent Skills: SKILL.md files that teach an AI assistant how to do one kind of task well.\n\
\n\
You are shown a chat between a user and an assistant: what the user asked, and which tools the assistant used. Turn it into a reusable skill for doing this kind of task again, with different details.\n\
\n\
Reply with only one JSON object, no other text:\n\
{\"name\": \"...\", \"description\": \"...\", \"body\": \"...\"}\n\
\n\
- name: lowercase letters, numbers and single hyphens, at most 64 characters, e.g. \"weekly-sales-report\".\n\
- description: one or two sentences, at most 1024 characters, saying what the skill does and when to use it (\"Use when the user asks for ...\").\n\
- body: Markdown instructions for the assistant: the goal, the steps in order, which tools to use and how, what a good result looks like, and mistakes to avoid. General, not tied to this one chat.\n\
\n\
Leave out anything personal or secret from the chat: names, addresses, keys, passwords, private links. Use placeholders instead.";

const REQUEST: &str = "Turn what happened in this chat into a skill I can use again.";

/// A drafted skill, as the dialog edits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub body: String,
}

static CURRENT: Mutex<Option<(u64, CancellationToken)>> = Mutex::new(None);
static NEXT_DRAFT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Stop the skill draft in progress, if any; whether there was one. Separate
/// from the workflow drafter's, so stopping one never stops the other.
pub fn cancel_current() -> bool {
    match CURRENT.lock() {
        Ok(mut current) => match current.take() {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

/// Draft a skill from the chat `conversation_id` with the active model,
/// within [`DRAFT_TIMEOUT`]: the one draft [`cancel_current`] stops. Starting
/// another stops the one before it.
pub async fn draft_from_chat(
    state: &AppState,
    streams: &StreamManager,
    conversation_id: &str,
) -> Result<SkillDraft, String> {
    let transcript = author::chat_transcript_or(state, conversation_id, EMPTY_CHAT).await?;
    let stop = CancellationToken::new();
    let mine = NEXT_DRAFT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut current) = CURRENT.lock() {
        if let Some((_, old)) = current.replace((mine, stop.clone())) {
            old.cancel();
        }
    }
    let result = draft_within(state, streams, &transcript, &stop, DRAFT_TIMEOUT).await;
    if let Ok(mut current) = CURRENT.lock() {
        if current.as_ref().is_some_and(|(id, _)| *id == mine) {
            *current = None;
        }
    }
    result
}

/// Draft a skill from a chat transcript (from
/// [`author::chat_transcript`]) with its own stop token and time limit.
pub async fn draft_within(
    state: &AppState,
    streams: &StreamManager,
    transcript: &str,
    stop: &CancellationToken,
    limit: Duration,
) -> Result<SkillDraft, String> {
    if transcript.trim().is_empty() {
        return Err(EMPTY_CHAT.to_string());
    }
    let settings = state.settings()?;
    if settings.active_model.trim().is_empty() {
        return Err("Choose a model in Settings first.".to_string());
    }
    let deadline = tokio::time::Instant::now() + limit;
    let conversation_id = author::drafting_conversation(state).await?;
    let prompt = format!("<chat>\n{transcript}\n</chat>\n\n{REQUEST}");
    let mut turns: Vec<(MessageRole, String)> = vec![(MessageRole::User, prompt)];
    let mut attempts = 0;
    loop {
        attempts += 1;
        let reply = author::ask_model(
            state,
            streams,
            &conversation_id,
            &settings.active_model,
            SYSTEM,
            &turns,
            stop,
            deadline,
        )
        .await?;
        let feedback = match read_reply(&reply) {
            Ok(draft) => return Ok(draft),
            Err(Problem::NotJson) => JSON_REPAIR.to_string(),
            Err(Problem::Invalid(problems)) => format!(
                "Fix these problems and reply with the whole JSON again:\n{}",
                problems
                    .iter()
                    .map(|p| format!("- {p}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        };
        if attempts > MAX_REPAIRS {
            return Err(NOTHING_USABLE.to_string());
        }
        turns.push((MessageRole::Assistant, reply));
        turns.push((MessageRole::User, feedback));
    }
}

enum Problem {
    NotJson,
    Invalid(Vec<String>),
}

/// The draft in a reply, with its name made valid when it can be; or what is
/// wrong with it, in words the model can act on.
fn read_reply(reply: &str) -> Result<SkillDraft, Problem> {
    let Some(Value::Object(map)) = parse_json_reply(reply) else {
        return Err(Problem::NotJson);
    };
    let text = |key: &str| {
        map.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    };
    let (raw_name, description, body) = (text("name"), text("description"), text("body"));
    let mut problems = Vec::new();
    let name = if skills::is_valid_skill_name(&raw_name) {
        Some(raw_name)
    } else {
        skills::normalize_skill_name(&raw_name)
    };
    if name.is_none() {
        problems.push(
            "\"name\" must be lowercase letters, numbers and single hyphens (1 to 64 characters)."
                .to_string(),
        );
    }
    if description.is_empty() {
        problems.push("\"description\" is missing.".to_string());
    } else if description.chars().count() > MAX_DESCRIPTION_CHARS {
        problems.push(format!(
            "\"description\" is longer than {MAX_DESCRIPTION_CHARS} characters; shorten it."
        ));
    }
    if body.is_empty() {
        problems.push("\"body\" is missing; write the instructions there.".to_string());
    }
    let Some(name) = name.filter(|_| problems.is_empty()) else {
        return Err(Problem::Invalid(problems));
    };
    // The same check a saved skill goes through.
    if let Err(problem) =
        skills::parse_skill_md(&skills::format_skill_md(&name, &description, &body))
    {
        return Err(Problem::Invalid(vec![problem]));
    }
    Ok(SkillDraft {
        name,
        description,
        body,
    })
}

/// Save a draft as a managed skill and, with `conversation_id`, turn it on
/// for that chat. A skill of the same name is an
/// [`skills::EXISTS_ERROR_PREFIX`] error unless `replace` is set.
pub async fn save(
    pool: &sqlx::SqlitePool,
    conduit_skills: &Path,
    draft: &SkillDraft,
    replace: bool,
    conversation_id: Option<&str>,
) -> Result<SkillSummary, String> {
    let summary = skills::save_skill(
        conduit_skills,
        &draft.name,
        &draft.description,
        &draft.body,
        replace,
    )?;
    if let Some(conversation_id) = conversation_id.filter(|c| !c.trim().is_empty()) {
        let mut enabled = skill_repo::list_enabled(pool, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        let id = skills::skill_id(SkillSource::Managed, &summary.name);
        if !enabled.contains(&id) {
            enabled.push(id);
            skill_repo::set_enabled(pool, conversation_id, &enabled)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_with_a_loose_name_is_normalised() {
        let draft = read_reply(
            r#"{"name": "Weekly Sales Report", "description": "Use when: weekly numbers.", "body": "1. Fetch."}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(draft.name, "weekly-sales-report");
        assert_eq!(draft.description, "Use when: weekly numbers.");
    }

    #[test]
    fn a_reply_missing_parts_lists_them() {
        let Err(Problem::Invalid(problems)) = read_reply(r#"{"name": "!!!", "description": ""}"#)
        else {
            panic!("expected problems");
        };
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(matches!(read_reply("Sure!"), Err(Problem::NotJson)));
    }
}
