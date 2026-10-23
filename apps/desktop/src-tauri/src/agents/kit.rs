//! What one of the user's agents brings to a turn of its own, wherever it
//! runs (a chat turn as the agent, a task handed to it, a workflow step run
//! as it, a workflow's helper):
//!
//! - **Notes** (`AgentDef::memory`): the notes it keeps between runs, scoped
//!   `agent:<id>` in `memory_items`, in its system prompt as "## Your notes"
//!   with their ids, and the `remember` / `forget` tools to keep them. A note
//!   it writes is active at once, even in a run nobody watches (a routine
//!   must remember yesterday's report), and records where it was written. It
//!   can only change or remove its own notes. The app-wide memory switch
//!   turns this off too.
//! - **Knowledge** (`AgentDef::knowledge`): a `search_documents` tool over
//!   exactly the collections it lists, through
//!   `commands::knowledge::retrieve_groups`. A collection that can't be
//!   searched is named in the tool's result in plain words, never asked
//!   about: nobody may be there to answer.
//!
//! These tools are the agent's own, not built-ins: the turn offers them as
//! it offers `ask_` tools ([`TurnOptions::kit`]), and the global `remember`
//! (which only proposes a memory for the user to save) is never offered
//! beside them.
//!
//! [`TurnOptions::kit`]: crate::stream_manager::TurnOptions::kit

use std::future::Future;
use std::pin::Pin;

use provider_core::schema::{PermissionLevel, ProviderRequest, ToolDefinition};
use serde_json::{json, Value};

use crate::commands::knowledge::{self as knowledge_commands, AdapterLookup};
use crate::db::repository::knowledge as library;
use crate::db::repository::memory::{
    self, agent_scope, compose_notes_block, MemoryKind, MemoryOrigin, MemoryStatus, NewMemory,
};
use crate::knowledge::search::{DocumentFilter, GroupMember};
use crate::state::AppState;
use crate::workflows::definition::{AgentDef, DEFAULT_TOP_K, MAX_TOP_K};
use crate::workflows::models;
use crate::workflows::runner::{cap_text, MAX_MODEL_TEXT_CHARS};

pub const REMEMBER_TOOL: &str = "remember";
pub const FORGET_TOOL: &str = "forget";
pub const SEARCH_DOCUMENTS_TOOL: &str = "search_documents";

/// Most notes one agent keeps; past it, it must replace or forget one.
pub const MAX_AGENT_NOTES: i64 = 50;

/// A boxed future. The kit's work is started from deep inside an agent's
/// turn (a helper's turn runs inside its lead's tool call), where a debug
/// build's stack is short; boxed where it is made, its state never takes
/// room in the caller's frame.
pub type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One agent's notes and collections for one turn. See the module docs.
#[derive(Debug, Clone)]
pub struct AgentKit {
    /// The agent's name, for the tools' descriptions.
    name: String,
    /// `agent:<id>` when it keeps notes this turn.
    scope: Option<String>,
    origin: MemoryOrigin,
    /// Its notes as they stood when the turn began.
    notes_block: String,
    /// The collections it reads, by id, with their names (`None` for one
    /// that no longer exists).
    collections: Vec<(String, Option<String>)>,
}

impl AgentKit {
    /// What `agent` brings to a turn written from `origin`; `None` when it
    /// keeps no notes this turn and reads no collections. `owner` is the id
    /// it keeps notes under: one of the user's agents' own id; `None` for a
    /// workflow's own helper, which never does.
    pub fn load<'a>(
        state: &'a AppState,
        owner: Option<&'a str>,
        agent: &'a AgentDef,
        origin: MemoryOrigin,
    ) -> Boxed<'a, Result<Option<Self>, String>> {
        Box::pin(Self::load_now(state, owner, agent, origin))
    }

    async fn load_now(
        state: &AppState,
        owner: Option<&str>,
        agent: &AgentDef,
        origin: MemoryOrigin,
    ) -> Result<Option<Self>, String> {
        let enabled = state.settings()?.memory_enabled;
        let scope = owner
            .map(str::trim)
            .filter(|id| agent.memory && enabled && !id.is_empty())
            .map(agent_scope);
        let mut collections: Vec<(String, Option<String>)> = Vec::new();
        for id in agent
            .knowledge
            .iter()
            .map(|c| c.trim())
            .filter(|c| !c.is_empty())
        {
            if collections.iter().any(|(c, _)| c == id) {
                continue;
            }
            let name = library::get_collection(&state.db, id)
                .await
                .map_err(|e| e.to_string())?
                .map(|c| c.name);
            collections.push((id.to_string(), name));
        }
        if scope.is_none() && collections.is_empty() {
            return Ok(None);
        }
        let notes_block = match &scope {
            Some(scope) => {
                let notes = memory::list_in(
                    &state.db,
                    &state.encryption,
                    Some(MemoryStatus::Active),
                    scope,
                )
                .await
                .map_err(|e| e.to_string())?;
                compose_notes_block(&notes)
            }
            None => String::new(),
        };
        Ok(Some(Self {
            name: agent.name.trim().to_string(),
            scope,
            origin,
            notes_block,
            collections,
        }))
    }

    /// Whether it keeps notes this turn.
    pub fn remembers(&self) -> bool {
        self.scope.is_some()
    }

    /// The collections it reads, by id.
    pub fn collection_ids(&self) -> Vec<String> {
        self.collections.iter().map(|(id, _)| id.clone()).collect()
    }

    /// What goes at the end of its system prompt: its notes. Empty when it
    /// keeps none this turn.
    pub fn system_block(&self) -> &str {
        &self.notes_block
    }

    /// `system` with [`Self::system_block`] after it.
    pub fn add_to_system(&self, system: &mut String) {
        if self.notes_block.is_empty() {
            return;
        }
        if !system.trim().is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(&self.notes_block);
    }

    /// Its notes in `request`'s system prompt and its tools in its tools, in
    /// place of any of the same name.
    pub fn add_to_request(&self, request: &mut ProviderRequest) {
        let mut system = request.system_prompt.take().unwrap_or_default();
        self.add_to_system(&mut system);
        request.system_prompt = Some(system);
        let definitions = self.definitions();
        request
            .tool_definitions
            .retain(|d| !definitions.iter().any(|own| own.name == d.name));
        request.tool_definitions.extend(definitions);
    }

    /// The tools it is offered.
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut out = Vec::new();
        if self.remembers() {
            out.push(definition(
                REMEMBER_TOOL,
                "Save a note for yourself: something worth knowing on your next run (what you already covered, what the user prefers, what to check next). It is kept between runs and shown to you under \"Your notes\". To update a note instead of adding another, pass its id as `replaces`. Keep each note to one or two sentences.".to_string(),
                json!({
                    "type": "object",
                    "properties": {
                        "fact": { "type": "string", "description": "The note, one or two sentences." },
                        "replaces": { "type": "string", "description": "The id of one of your notes this one replaces." }
                    },
                    "required": ["fact"]
                }),
                PermissionLevel::SideEffectful,
            ));
            out.push(definition(
                FORGET_TOOL,
                "Remove one of your notes that is no longer true or useful. Pass its id from \"Your notes\".".to_string(),
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "The id of the note to remove." }
                    },
                    "required": ["id"]
                }),
                PermissionLevel::SideEffectful,
            ));
        }
        if !self.collections.is_empty() {
            let names: Vec<String> = self
                .collections
                .iter()
                .map(|(id, name)| format!("\u{201c}{}\u{201d}", name.as_deref().unwrap_or(id)))
                .collect();
            out.push(definition(
                SEARCH_DOCUMENTS_TOOL,
                format!(
                    "Search the user's saved documents that {} may read ({}) for passages about `query`. Returns the best passages with the document each comes from; cite the document when you use one. Optional `topK`: how many passages, 1 to {MAX_TOP_K} ({DEFAULT_TOP_K} by default).",
                    if self.name.is_empty() { "you" } else { &self.name },
                    names.join(", ")
                ),
                json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "What to look for, in words." },
                        "topK": { "type": "integer", "description": "How many passages to return." }
                    },
                    "required": ["query"]
                }),
                PermissionLevel::ReadOnly,
            ));
        }
        out
    }

    /// Whether `name` is one of its tools.
    pub fn offers(&self, name: &str) -> bool {
        match name {
            REMEMBER_TOOL | FORGET_TOOL => self.remembers(),
            SEARCH_DOCUMENTS_TOOL => !self.collections.is_empty(),
            _ => false,
        }
    }

    /// Run its tool `name`: what the model gets back, or an error in words.
    pub fn call<'a>(
        &'a self,
        state: &'a AppState,
        adapters: AdapterLookup<'a>,
        name: &'a str,
        arguments: &'a Value,
    ) -> Boxed<'a, Result<Value, String>> {
        Box::pin(self.call_now(state, adapters, name, arguments))
    }

    async fn call_now(
        &self,
        state: &AppState,
        adapters: AdapterLookup<'_>,
        name: &str,
        arguments: &Value,
    ) -> Result<Value, String> {
        match (name, &self.scope) {
            (REMEMBER_TOOL, Some(scope)) => self.remember(state, scope, arguments).await,
            (FORGET_TOOL, Some(scope)) => forget(state, scope, arguments).await,
            (SEARCH_DOCUMENTS_TOOL, _) if !self.collections.is_empty() => {
                self.search(state, adapters, arguments).await
            }
            _ => Err("That tool isn't available.".to_string()),
        }
    }

    async fn remember(
        &self,
        state: &AppState,
        scope: &str,
        arguments: &Value,
    ) -> Result<Value, String> {
        let fact = arguments["fact"].as_str().unwrap_or_default();
        let fact = memory::validate_body(fact).map_err(|e| match e.as_str() {
            "memory fact cannot be empty" => "Say what to remember, as \"fact\".".to_string(),
            _ => format!(
                "A note can be up to {} characters; keep it to one or two sentences.",
                memory::MEMORY_BODY_MAX_CHARS
            ),
        })?;
        let replaces = arguments["replaces"]
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some(id) = replaces {
            own_note(state, scope, id, "replaced").await?;
            let note = memory::rewrite(&state.db, &state.encryption, id, &fact, Some(self.origin))
                .await
                .map_err(|e| e.to_string())?;
            return Ok(json!({ "ok": true, "noteId": note.id, "replaced": true }));
        }
        let kept = memory::count_in(&state.db, scope)
            .await
            .map_err(|e| e.to_string())?;
        if kept >= MAX_AGENT_NOTES {
            return Err(format!(
                "You already keep {MAX_AGENT_NOTES} notes. Replace one (pass its id as \"replaces\") or forget one first."
            ));
        }
        let note = memory::create(
            &state.db,
            &state.encryption,
            NewMemory {
                kind: MemoryKind::Note,
                body: fact,
                source_conversation_id: None,
                pinned: false,
                status: MemoryStatus::Active,
                scope: scope.to_string(),
                origin: Some(self.origin),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(json!({ "ok": true, "noteId": note.id }))
    }

    async fn search(
        &self,
        state: &AppState,
        adapters: AdapterLookup<'_>,
        arguments: &Value,
    ) -> Result<Value, String> {
        let query = arguments["query"].as_str().unwrap_or_default().trim();
        if query.is_empty() {
            return Err("Say what to look for, as \"query\".".to_string());
        }
        let top_k = top_k(&arguments["topK"]).unwrap_or(DEFAULT_TOP_K);
        // What can't be searched, and why, in words; the rest is searched.
        let mut cannot: Vec<String> = Vec::new();
        let mut groups: Vec<((String, String), Vec<GroupMember>)> = Vec::new();
        for (id, _) in &self.collections {
            let Some(collection) = library::get_collection(&state.db, id)
                .await
                .map_err(|e| e.to_string())?
            else {
                cannot.push(format!(
                    "One of the collections you read (\u{201c}{id}\u{201d}) no longer exists."
                ));
                continue;
            };
            let label = models::provider_label(&collection.provider_id);
            if knowledge_commands::ensure_provider_allowed_offline(state, &collection.provider_id)
                .is_err()
            {
                cannot.push(format!(
                    "\u{201c}{}\u{201d} can't be searched: local-only mode is on, and its documents were indexed with {label}.",
                    collection.name
                ));
                continue;
            }
            if knowledge_commands::ensure_consented(state, &collection.provider_id).is_err() {
                cannot.push(format!(
                    "\u{201c}{}\u{201d} can't be searched until the user allows sending documents to {label} (in Documents).",
                    collection.name
                ));
                continue;
            }
            let document_ids = library::list_documents_by_collection(&state.db, &collection.id)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|d| d.id)
                .collect();
            let key = (collection.provider_id, collection.embedding_model);
            let member = GroupMember {
                collection_id: collection.id,
                collection_name: collection.name,
                document_ids,
            };
            match groups.iter_mut().find(|(k, _)| *k == key) {
                Some((_, members)) => members.push(member),
                None => groups.push((key, vec![member])),
            }
        }
        let context = if groups.is_empty() {
            None
        } else {
            Some(
                knowledge_commands::retrieve_groups(
                    state,
                    adapters,
                    groups,
                    &DocumentFilter::unrestricted(),
                    query,
                    top_k as usize,
                )
                .await
                .map_err(|e| e.fallback)?,
            )
        };
        let mut passages: Vec<Value> = Vec::new();
        let mut numbered: Vec<String> = Vec::new();
        if let Some(context) = &context {
            for name in &context.unavailable_collections {
                cannot.push(format!(
                    "\u{201c}{name}\u{201d} couldn't be searched just now: its embedding provider may not be set up."
                ));
            }
            for (i, (p, c)) in context.passages.iter().zip(&context.citations).enumerate() {
                passages.push(json!({
                    "document": p.document,
                    "collection": p.collection,
                    "text": p.text,
                    "citation": format!("{} ({})", c.document_title, c.collection_name),
                }));
                numbered.push(format!(
                    "[{}] {} ({})\n{}",
                    i + 1,
                    p.document,
                    p.collection,
                    p.text
                ));
            }
        }
        let mut out = json!({
            "count": passages.len(),
            "passages": passages,
            "text": cap_text(&numbered.join("\n\n"), MAX_MODEL_TEXT_CHARS),
        });
        if !cannot.is_empty() {
            out["unavailable"] = Value::String(cannot.join(" "));
        }
        if passages.is_empty() && !cannot.is_empty() && context.is_none() {
            out["text"] = Value::String(format!("Nothing was searched. {}", cannot.join(" ")));
        }
        Ok(out)
    }
}

/// The note `id`, when it is one of the notes in `scope`; otherwise why it
/// can't be `done` (replaced, forgotten).
async fn own_note(state: &AppState, scope: &str, id: &str, done: &str) -> Result<(), String> {
    let note = memory::get(&state.db, &state.encryption, id)
        .await
        .map_err(|e| e.to_string())?;
    match note {
        Some(note) if note.scope == scope => Ok(()),
        Some(_) => Err(format!(
            "The note \u{201c}{id}\u{201d} isn't one of yours, so it can't be {done}. You can only change the notes listed under \"Your notes\"."
        )),
        None => Err(format!(
            "There is no note \u{201c}{id}\u{201d}. Use an id from \"Your notes\"."
        )),
    }
}

async fn forget(state: &AppState, scope: &str, arguments: &Value) -> Result<Value, String> {
    let id = arguments["id"].as_str().map(str::trim).unwrap_or_default();
    if id.is_empty() {
        return Err("Say which note to forget, as \"id\".".to_string());
    }
    own_note(state, scope, id, "forgotten").await?;
    memory::delete(&state.db, id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "forgot": id }))
}

/// `topK` read leniently (weak models send `"5"` or `5.0`), kept in range.
fn top_k(value: &Value) -> Option<u32> {
    let n = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !n.is_finite() {
        return None;
    }
    Some((n.round().max(1.0) as u32).min(MAX_TOP_K))
}

fn definition(
    name: &str,
    description: String,
    input_schema: Value,
    level: PermissionLevel,
) -> ToolDefinition {
    ToolDefinition {
        tool_id: name.to_string(),
        name: name.to_string(),
        description,
        input_schema,
        kind: None,
        host_config: None,
        permission_level: Some(level),
        display_group: Some(
            if name == SEARCH_DOCUMENTS_TOOL {
                "Documents"
            } else {
                "Memory"
            }
            .to_string(),
        ),
        tenant_scope: None,
    }
}

/// The origin of a note written in a workflow run: a scheduled run when
/// nobody is watching it.
pub fn run_origin(unattended: bool) -> MemoryOrigin {
    if unattended {
        MemoryOrigin::ScheduledRun
    } else {
        MemoryOrigin::Run
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_k_is_read_leniently_and_kept_in_range() {
        assert_eq!(top_k(&json!(5)), Some(5));
        assert_eq!(top_k(&json!("3")), Some(3));
        assert_eq!(top_k(&json!(4.0)), Some(4));
        assert_eq!(top_k(&json!(0)), Some(1));
        assert_eq!(top_k(&json!(500)), Some(MAX_TOP_K));
        assert_eq!(top_k(&Value::Null), None);
    }
}
