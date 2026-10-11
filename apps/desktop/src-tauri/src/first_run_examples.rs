//! First-run examples: a new profile starts with things to look at instead
//! of empty pages. When onboarding finishes on an empty profile, Conduit adds
//! the World weather app, the chat it came from, a deck about how language
//! models work with its chat, a rainy-day plan, and the Morning briefing with
//! one result waiting, all in the language the user picked.
//!
//! Everything is written ahead of time (`first_run/<locale>.json`) and stored
//! through the usual repository functions, so it needs no API key and looks
//! exactly like the user's own work. Each item is listed in `example_items`
//! (migration 0037) so the interface can mark it "Example" and remove them
//! all at once. Examples are only ever offered once: `examples_seeded` is set
//! whether or not anything was added.

use std::collections::HashSet;

use chrono::{Duration, Utc};
use provider_core::schema::{
    AppCategory, DeckSnapshotCause, DeckStage, Message, MessagePart, MessagePartKind, MessageRole,
    SettingsPatch, StorylineItem,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::repository::apps::{self, AppMeta};
use crate::db::repository::artifact_network::{self as grants, Principal};
use crate::db::repository::artifacts::{self, ArtifactContent};
use crate::db::repository::workflows as workflow_repo;
use crate::db::repository::{conversations, messages, slides};
use crate::db::DbError;
use crate::slide_layouts::{self, Layout, SlideFields};
use crate::state::AppState;
use crate::time::now_iso8601;

/// The starter app the examples install.
pub const WEATHER_STARTER: &str = "world-weather";

/// The languages there are examples for, and their content.
const CONTENT: &[(&str, &str)] = &[
    ("en", include_str!("../first_run/en.json")),
    ("de", include_str!("../first_run/de.json")),
    ("es", include_str!("../first_run/es.json")),
    ("fr", include_str!("../first_run/fr.json")),
    ("ja", include_str!("../first_run/ja.json")),
    ("ko", include_str!("../first_run/ko.json")),
    ("pt-BR", include_str!("../first_run/pt-BR.json")),
    ("zh-CN", include_str!("../first_run/zh-CN.json")),
];

/// One language's examples.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Content {
    pub weather: AppText,
    pub weather_chat: Chat,
    pub deck: DeckContent,
    pub rainy_chat: Chat,
    pub briefing: Briefing,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppText {
    pub name: String,
    pub description: String,
}

/// A chat of one question and one answer that wrote a document.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chat {
    pub title: String,
    pub user: String,
    pub assistant: String,
    pub document_title: String,
    /// The document's Markdown; `None` for the weather chat, whose document
    /// is the World weather page itself.
    #[serde(default)]
    pub document: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeckContent {
    pub title: String,
    pub user: String,
    pub assistant: String,
    pub slides: Vec<SlideSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlideSpec {
    pub layout: String,
    pub fields: SlideFields,
    pub notes: String,
}

/// The Morning briefing as this language's user gets it, and the result of
/// a real run captured when the release was made.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Briefing {
    pub name: String,
    pub description: String,
    /// Input values for the workflow (`site_one`, `site_two`, `interests`,
    /// `language`), which also become its defaults.
    pub inputs: serde_json::Map<String, Value>,
    /// When the captured run happened (UTC, ISO 8601).
    pub run_started_at: String,
    pub run_finished_at: String,
    pub document_title: String,
    pub document: String,
}

/// The content for `locale`, or English when there is none.
pub fn content(locale: &str) -> Result<Content, String> {
    let primary = locale.split(['-', '_']).next().unwrap_or("en");
    let raw = CONTENT
        .iter()
        .find(|(l, _)| l.eq_ignore_ascii_case(locale))
        .or_else(|| {
            CONTENT
                .iter()
                .find(|(l, _)| l.split('-').next() == Some(primary))
        })
        .or_else(|| CONTENT.iter().find(|(l, _)| *l == "en"))
        .map(|(_, raw)| *raw)
        .ok_or("There are no examples.")?;
    serde_json::from_str(raw).map_err(|e| format!("The examples can't be read: {e}"))
}

/// What the renderer passes in: things only it has.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedRequest {
    /// The interface language (`en`, `pt-BR`...).
    pub locale: String,
    /// The deck theme (built in the renderer).
    pub theme_name: String,
    pub theme_css: String,
    /// The Morning briefing starter's definition.
    pub briefing_definition: Value,
}

/// What seeding did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedOutcome {
    /// Whether examples were added (false: the profile wasn't new, or they
    /// were offered before).
    pub seeded: bool,
    pub items: Vec<ExampleItem>,
}

/// One example, by kind (`app`, `chat`, `deck`, `workflow`) and id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleItem {
    pub kind: String,
    pub item_id: String,
}

/// Whether the profile has nothing of the user's yet: no chats of any kind,
/// apps, decks or workflows.
pub async fn profile_is_empty(pool: &SqlitePool) -> Result<bool, DbError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM apps) \
         + (SELECT COUNT(*) FROM decks) + (SELECT COUNT(*) FROM workflows)",
    )
    .fetch_one(pool)
    .await?;
    Ok(count == 0)
}

/// Add the examples once, to a new profile. Marks the profile as offered
/// either way. On a failure partway, removes what it added and says why.
pub async fn seed(state: &AppState, request: &SeedRequest) -> Result<SeedOutcome, String> {
    let settings = state.settings()?;
    let fresh = profile_is_empty(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let offered = settings.examples_seeded;
    // Never again, whatever happens below.
    let patch: SettingsPatch =
        serde_json::from_value(json!({ "examplesSeeded": true })).map_err(|e| e.to_string())?;
    state.update_settings(patch).map_err(|e| e.to_string())?;
    if offered || !fresh {
        return Ok(SeedOutcome {
            seeded: false,
            items: Vec::new(),
        });
    }
    let content = content(&request.locale)?;
    let mut added = Vec::new();
    match add_all(state, request, &content, &mut added).await {
        Ok(()) => Ok(SeedOutcome {
            seeded: true,
            items: added,
        }),
        Err(e) => {
            tracing::warn!(error = %e, "first-run examples failed; removing what was added");
            let _ = remove(state, &added).await;
            Err(e)
        }
    }
}

async fn add_all(
    state: &AppState,
    request: &SeedRequest,
    content: &Content,
    added: &mut Vec<ExampleItem>,
) -> Result<(), String> {
    // Oldest first, so the newest (the briefing) leads on Home.
    add_weather(state, content, added).await?;
    add_deck(state, request, content, added).await?;
    add_rainy_chat(state, content, added).await?;
    add_briefing(state, request, content, added).await?;
    Ok(())
}

async fn record(
    pool: &SqlitePool,
    added: &mut Vec<ExampleItem>,
    kind: &str,
    id: &str,
) -> Result<(), String> {
    sqlx::query("INSERT OR IGNORE INTO example_items (kind, item_id, created_at) VALUES (?, ?, ?)")
        .bind(kind)
        .bind(id)
        .bind(now_iso8601())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    added.push(ExampleItem {
        kind: kind.to_string(),
        item_id: id.to_string(),
    });
    Ok(())
}

async fn add_weather(
    state: &AppState,
    content: &Content,
    added: &mut Vec<ExampleItem>,
) -> Result<(), String> {
    let pool = &state.db;
    let starter = crate::starter_apps::find(WEATHER_STARTER)
        .ok_or("The World weather app is missing from this build.")?;
    let meta = AppMeta {
        name: content.weather.name.clone(),
        description: Some(content.weather.description.clone()),
        icon: Some(starter.icon.to_string()),
        category: AppCategory::LiveData,
    }
    .validated()?;
    let app = apps::install_starter(pool, &state.encryption, starter, meta)
        .await
        .map_err(|e| e.to_string())?;
    record(pool, added, "app", &app.id).await?;
    // Its weather sites are allowed ahead of time: a permission prompt
    // shouldn't be the first thing a new user sees.
    for host in starter.hosts {
        grants::grant(pool, &Principal::app(&app.id), host)
            .await
            .map_err(|e| e.to_string())?;
    }
    let chat = &content.weather_chat;
    let conversation = add_chat(
        state,
        chat,
        "html",
        crate::agent_tools::WRITE_HTML_TOOL,
        starter.html,
    )
    .await?;
    record(pool, added, "chat", &conversation).await
}

async fn add_rainy_chat(
    state: &AppState,
    content: &Content,
    added: &mut Vec<ExampleItem>,
) -> Result<(), String> {
    let chat = &content.rainy_chat;
    let document = chat
        .document
        .as_deref()
        .ok_or("The rainy-day example has no document.")?;
    let conversation = add_chat(
        state,
        chat,
        "markdown",
        crate::agent_tools::WRITE_MARKDOWN_TOOL,
        document,
    )
    .await?;
    record(&state.db, added, "chat", &conversation).await
}

/// A chat with a question, an answer, and the document the answer wrote.
/// Returns the conversation id.
async fn add_chat(
    state: &AppState,
    chat: &Chat,
    kind: &str,
    tool: &str,
    document: &str,
) -> Result<String, String> {
    let pool = &state.db;
    let conversation = conversations::create(pool, Some(&chat.title))
        .await
        .map_err(|e| e.to_string())?;
    let assistant = write_exchange(
        pool,
        &conversation.id,
        &chat.user,
        &chat.assistant,
        Some(tool),
    )
    .await?;
    save_document(
        state,
        &conversation.id,
        Some(&assistant),
        kind,
        &chat.document_title,
        document,
    )
    .await?;
    Ok(conversation.id)
}

/// A user message and the assistant's answer, a second apart, and the
/// assistant message's id. `tool` adds the call that wrote a document, which
/// is how the chat ties the document to the answer.
async fn write_exchange(
    pool: &SqlitePool,
    conversation_id: &str,
    user: &str,
    assistant: &str,
    tool: Option<&str>,
) -> Result<String, String> {
    let asked = Utc::now() - Duration::seconds(2);
    let at = |t: chrono::DateTime<Utc>| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let user_id = Uuid::new_v4().to_string();
    messages::insert_message(
        pool,
        &message(
            conversation_id,
            &user_id,
            MessageRole::User,
            &at(asked),
            vec![(MessagePartKind::Text, user.to_string())],
        ),
    )
    .await
    .map_err(|e| e.to_string())?;
    let assistant_id = Uuid::new_v4().to_string();
    let mut parts = Vec::new();
    if let Some(tool) = tool {
        parts.push((MessagePartKind::ToolCall, format!("Tool call: {tool}")));
    }
    parts.push((MessagePartKind::Text, assistant.to_string()));
    messages::insert_message(
        pool,
        &message(
            conversation_id,
            &assistant_id,
            MessageRole::Assistant,
            &at(asked + Duration::seconds(1)),
            parts,
        ),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(assistant_id)
}

fn message(
    conversation_id: &str,
    id: &str,
    role: MessageRole,
    at: &str,
    parts: Vec<(MessagePartKind, String)>,
) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: Some(json!({ "example": true })),
        parts: parts
            .into_iter()
            .enumerate()
            .map(|(index, (kind, text))| MessagePart {
                id: Uuid::new_v4().to_string(),
                message_id: id.to_string(),
                index: index as u32,
                tool_call_id: (kind == MessagePartKind::ToolCall)
                    .then(|| format!("example-{}", Uuid::new_v4())),
                kind,
                content: Some(text),
                mime_type: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: at.to_string(),
            })
            .collect(),
        created_at: at.to_string(),
    }
}

/// Save a document in `conversation_id`, written by `source_message_id`.
async fn save_document(
    state: &AppState,
    conversation_id: &str,
    source_message_id: Option<&str>,
    kind: &str,
    title: &str,
    text: &str,
) -> Result<String, String> {
    let pool = &state.db;
    let artifact = artifacts::create(pool, conversation_id, kind, Some(title), source_message_id)
        .await
        .map_err(|e| e.to_string())?;
    let mime = if kind == "html" {
        "text/html"
    } else {
        "text/markdown"
    };
    artifacts::set_content(
        pool,
        &state.paths.artifacts,
        &state.encryption,
        &artifact.id,
        Some(mime),
        &ArtifactContent::Text {
            text: text.to_string(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(artifact.id)
}

async fn add_deck(
    state: &AppState,
    request: &SeedRequest,
    content: &Content,
    added: &mut Vec<ExampleItem>,
) -> Result<(), String> {
    let pool = &state.db;
    let enc = &state.encryption;
    let deck_content = &content.deck;
    // Build every slide first: a bad one stops here, before anything is saved.
    let built = deck_content
        .slides
        .iter()
        .map(build_slide)
        .collect::<Result<Vec<_>, _>>()?;
    let conversation = conversations::create(pool, Some(&deck_content.title))
        .await
        .map_err(|e| e.to_string())?;
    let deck = slides::create(
        pool,
        enc,
        &deck_content.title,
        &request.theme_name,
        &request.theme_css,
        Some(&conversation.id),
    )
    .await
    .map_err(|e| e.to_string())?;
    record(pool, added, "deck", &deck.id).await?;
    let storyline = deck_content
        .slides
        .iter()
        .map(|s| StorylineItem {
            id: Uuid::new_v4().to_string(),
            text: plain(s.fields.headline.as_deref().unwrap_or_default()),
        })
        .collect();
    slides::set_storyline(pool, enc, &deck.id, storyline)
        .await
        .map_err(|e| e.to_string())?;
    for (layout, html, notes) in &built {
        slides::add_slide(pool, enc, &deck.id, layout, html, notes, None)
            .await
            .map_err(|e| e.to_string())?;
    }
    slides::set_stage(pool, enc, &deck.id, DeckStage::Slides)
        .await
        .map_err(|e| e.to_string())?;
    slides::snapshot(
        pool,
        enc,
        &deck.id,
        DeckSnapshotCause::Created,
        &deck_content.title,
    )
    .await
    .map_err(|e| e.to_string())?;
    write_exchange(
        pool,
        &conversation.id,
        &deck_content.user,
        &deck_content.assistant,
        None,
    )
    .await?;
    Ok(())
}

/// A slide's layout name, html and notes, built the way the model's slide
/// tools build them.
fn build_slide(spec: &SlideSpec) -> Result<(String, String, String), String> {
    let layout =
        Layout::parse(&spec.layout).ok_or_else(|| slide_layouts::unknown_layout(&spec.layout))?;
    let fields = slide_layouts::validate(layout, &spec.fields).map_err(|e| {
        format!(
            "Example slide \"{}\": {e}",
            plain(spec.fields.headline.as_deref().unwrap_or_default())
        )
    })?;
    let html = slide_layouts::render(layout, &fields)?;
    Ok((layout.name().to_string(), html, spec.notes.clone()))
}

/// `text` without tags, for a storyline line.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

async fn add_briefing(
    state: &AppState,
    request: &SeedRequest,
    content: &Content,
    added: &mut Vec<ExampleItem>,
) -> Result<(), String> {
    let pool = &state.db;
    let enc = &state.encryption;
    let briefing = &content.briefing;
    let definition = with_defaults(&request.briefing_definition, &briefing.inputs);
    let workflow = workflow_repo::create(
        pool,
        enc,
        &briefing.name,
        Some(&briefing.description),
        &definition,
    )
    .await
    .map_err(|e| e.to_string())?;
    record(pool, added, "workflow", &workflow.id).await?;
    let conversation = conversations::create(pool, Some(&briefing.name))
        .await
        .map_err(|e| e.to_string())?;
    conversations::set_kind(pool, &conversation.id, "automation")
        .await
        .map_err(|e| e.to_string())?;
    workflow_repo::set_conversation(pool, &workflow.id, &conversation.id)
        .await
        .map_err(|e| e.to_string())?;

    // The captured run: its inputs, and the save step that wrote the result.
    let run = workflow_repo::start_run(pool, &workflow.id, workflow.version, "manual")
        .await
        .map_err(|e| e.to_string())?;
    workflow_repo::set_run_inputs(pool, enc, &run.id, &Value::Object(briefing.inputs.clone()))
        .await
        .map_err(|e| e.to_string())?;
    let save_input = json!({
        "type": "save_artifact",
        "title": briefing.document_title,
        "content": briefing.document,
        "format": "markdown",
        "mode": "create",
        "onlyIfChanged": false,
    });
    let row = workflow_repo::start_step(pool, enc, &run.id, "save", None, &save_input)
        .await
        .map_err(|e| e.to_string())?;
    let artifact = save_document(
        state,
        &conversation.id,
        None,
        "markdown",
        &briefing.document_title,
        &briefing.document,
    )
    .await?;
    let output = json!({
        "artifactId": artifact,
        "title": briefing.document_title,
        "conversationId": conversation.id,
    });
    workflow_repo::finish_step(pool, enc, &row, "completed", Some(&output), None)
        .await
        .map_err(|e| e.to_string())?;
    workflow_repo::finish_run(pool, &run.id, "completed", None)
        .await
        .map_err(|e| e.to_string())?;
    workflow_repo::record_outputs(pool, enc, &run.id)
        .await
        .map_err(|e| e.to_string())?;
    // Dated when it really ran; left unread so it waits on Home.
    sqlx::query("UPDATE workflow_runs SET started_at = ?, finished_at = ? WHERE id = ?")
        .bind(&briefing.run_started_at)
        .bind(&briefing.run_finished_at)
        .bind(&run.id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE workflow_run_steps SET started_at = ?, finished_at = ? WHERE id = ?")
        .bind(&briefing.run_finished_at)
        .bind(&briefing.run_finished_at)
        .bind(&row)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `definition` with each input's default replaced by `values`.
fn with_defaults(definition: &Value, values: &serde_json::Map<String, Value>) -> Value {
    let mut definition = definition.clone();
    if let Some(inputs) = definition.get_mut("inputs").and_then(Value::as_array_mut) {
        for input in inputs {
            let id = input.get("id").and_then(Value::as_str).map(str::to_string);
            if let Some(value) = id.and_then(|id| values.get(&id).cloned()) {
                input["default"] = value;
            }
        }
    }
    definition
}

/// The examples this profile still has.
pub async fn list(pool: &SqlitePool) -> Result<Vec<ExampleItem>, DbError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT kind, item_id FROM example_items ORDER BY created_at, rowid")
            .fetch_all(pool)
            .await?;
    let mut items = Vec::new();
    for (kind, item_id) in rows {
        let table = match kind.as_str() {
            "app" => "apps",
            "chat" => "conversations",
            "deck" => "decks",
            "workflow" => "workflows",
            _ => continue,
        };
        let exists: Option<i64> =
            sqlx::query_scalar(&format!("SELECT 1 FROM {table} WHERE id = ?"))
                .bind(&item_id)
                .fetch_optional(pool)
                .await?;
        if exists.is_some() {
            items.push(ExampleItem { kind, item_id });
        }
    }
    Ok(items)
}

/// Delete `items` the way their own Delete buttons do, then forget them.
pub async fn remove(state: &AppState, items: &[ExampleItem]) -> Result<(), String> {
    let pool = &state.db;
    let paths = &state.paths;
    let delete_chat = |id: String| async move {
        conversations::delete_with_files(pool, &paths.artifacts, &paths.attachments, &id)
            .await
            .map_err(|e| e.to_string())
    };
    let mut done = HashSet::new();
    for item in items {
        if !done.insert(item.clone()) {
            continue;
        }
        let id = item.item_id.clone();
        match item.kind.as_str() {
            "app" => {
                crate::artifact_network::clear_session_grants(Some(&format!("app:{id}")));
                apps::delete(pool, &id).await.map_err(|e| e.to_string())?;
            }
            "chat" => delete_chat(id.clone()).await?,
            "deck" => {
                if let Some(conversation) =
                    slides::delete(pool, &id).await.map_err(|e| e.to_string())?
                {
                    delete_chat(conversation).await?;
                }
            }
            "workflow" => {
                let workflow = workflow_repo::get(pool, &state.encryption, &id)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(conversation) = workflow.and_then(|w| w.conversation_id) {
                    delete_chat(conversation).await?;
                }
                workflow_repo::delete(pool, &id)
                    .await
                    .map_err(|e| e.to_string())?;
                crate::workflows::triggers::remove_cursor(&paths.root, &id);
            }
            _ => {}
        }
        sqlx::query("DELETE FROM example_items WHERE kind = ? AND item_id = ?")
            .bind(&item.kind)
            .bind(&item.item_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove every example the profile still has, and forget the ones the
/// user already deleted.
pub async fn remove_all(state: &AppState) -> Result<usize, String> {
    let items = list(&state.db).await.map_err(|e| e.to_string())?;
    remove(state, &items).await?;
    sqlx::query("DELETE FROM example_items")
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(items.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_has_examples_that_build() {
        // Every slide problem in every language at once, so they can be fixed together.
        let mut problems = Vec::new();
        for (locale, _) in CONTENT {
            let content = content(locale).unwrap_or_else(|e| panic!("{locale}: {e}"));
            assert_eq!(content.deck.slides.len(), 8, "{locale}");
            for slide in &content.deck.slides {
                if let Err(e) = build_slide(slide) {
                    problems.push(format!("{locale}: {e}"));
                }
            }
            assert!(content.rainy_chat.document.is_some(), "{locale}");
            assert!(content.weather_chat.document.is_none(), "{locale}");
            for key in ["site_one", "site_two", "interests", "language"] {
                assert!(content.briefing.inputs.contains_key(key), "{locale}: {key}");
            }
            assert!(content.briefing.document.contains("](http"), "{locale}");
        }
        assert!(problems.is_empty(), "\n{}", problems.join("\n"));
    }

    #[test]
    fn a_language_falls_back_to_its_family_then_english() {
        assert!(content("pt").unwrap().briefing.document.len() > 100);
        assert_eq!(
            content("zh-TW").unwrap().deck.title,
            content("zh-CN").unwrap().deck.title
        );
        assert_eq!(
            content("xx").unwrap().deck.title,
            content("en").unwrap().deck.title
        );
    }

    #[test]
    fn defaults_follow_the_language() {
        let def = json!({ "inputs": [
            { "id": "site_one", "label": "First site", "default": "https://a.test" },
            { "id": "other", "label": "Other", "default": "keep" }
        ], "steps": [] });
        let mut values = serde_json::Map::new();
        values.insert("site_one".into(), json!("https://b.test"));
        let out = with_defaults(&def, &values);
        assert_eq!(out["inputs"][0]["default"], "https://b.test");
        assert_eq!(out["inputs"][1]["default"], "keep");
    }

    #[test]
    fn plain_drops_tags() {
        assert_eq!(
            plain("Text <span class=\"accent\">becomes</span> tokens"),
            "Text becomes tokens"
        );
    }
}
