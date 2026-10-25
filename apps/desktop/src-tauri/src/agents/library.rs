//! The agent library: agents defined once (the Agents page) and used as
//! helpers by any workflow.
//!
//! A workflow keeps only a reference, `{ "id": "x", "library": "x" }`, so
//! editing an agent changes it everywhere. [`resolve`] fills the references in
//! on a copy before the workflow is checked, shown permissions for or run; the
//! stored definition is never written back resolved.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db::repository::agent_calls::{self, AgentCallRow, ChatAgentActivity};
use crate::db::repository::agents as repo;
use crate::db::repository::{knowledge, memory};
use crate::encryption::Encryption;
use crate::workflows::definition::{
    apply_step_agents, check_helper_fields, check_helper_id, step_agents, AgentDef,
    WorkflowDefinition, MAX_HELPERS_PER_AGENT,
};

/// Longest agent id (the same as a helper's).
const MAX_ID_CHARS: usize = 40;

/// One of the user's agents, with where it is used.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAgent {
    /// Its definition; `agents` are ids of other library agents. Never has `library`.
    pub agent: AgentDef,
    pub created_at: String,
    pub updated_at: String,
    /// Workflows whose helpers include it, directly or through another agent.
    pub used_by: Vec<UsedBy>,
    /// What it has done in chat (turns run as it, tasks handed to it). Zeros
    /// until [`with_chat_activity`] fills it in.
    pub chat: ChatUse,
    /// How many notes it keeps (`memory::agent_scope`).
    pub notes: u64,
}

/// A library agent's work in chat, for its card on the Agents page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUse {
    pub tasks: u64,
    pub failed: u64,
    pub tokens: u64,
    pub last_active: Option<String>,
    pub current_task: Option<String>,
    pub current_conversation_id: Option<String>,
}

impl From<ChatAgentActivity> for ChatUse {
    fn from(a: ChatAgentActivity) -> Self {
        Self {
            tasks: a.tasks,
            failed: a.failed,
            tokens: a.tokens,
            last_active: a.last_active,
            current_task: a.current_task,
            current_conversation_id: a.current_conversation_id,
        }
    }
}

/// Fill in each agent's chat activity since `since` (an ISO time).
pub async fn with_chat_activity(
    pool: &SqlitePool,
    enc: &Encryption,
    agents: &mut [LibraryAgent],
    since: &str,
) -> Result<(), String> {
    let mut activity: HashMap<String, ChatAgentActivity> =
        agent_calls::chat_agent_activity(pool, enc, since)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|a| (a.agent_id.clone(), a))
            .collect();
    for agent in agents {
        if let Some(seen) = activity.remove(&agent.agent.id) {
            agent.chat = seen.into();
        }
    }
    Ok(())
}

/// Every agent call of a workflow run, in the order they started, for its
/// agent tree: each named by the user's agent of that id, else by the run's
/// workflow's own helper, else by its id (a step's id names it).
pub async fn agent_calls_of_run(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
) -> Result<Vec<AgentCallRow>, String> {
    let mut rows = agent_calls::list_agent_calls(pool, enc, run_id)
        .await
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(rows);
    }
    let library = load(pool, enc).await?;
    let workflow_id: Option<String> =
        sqlx::query_scalar("SELECT workflow_id FROM agent_calls WHERE run_id = ? LIMIT 1")
            .bind(run_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .flatten();
    let own: Vec<AgentDef> = match workflow_id {
        Some(id) => crate::db::repository::workflows::get(pool, enc, &id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|w| serde_json::from_value::<WorkflowDefinition>(w.definition).ok())
            .map(|def| def.agents)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let named = |name: &str| Some(name.trim().to_string()).filter(|n| !n.is_empty());
    // A step is named by its id, unless it ran as one of the user's agents
    // (then its row has that agent's id, not the step's).
    let ran_as_agent = |r: &AgentCallRow| r.step_id.as_deref() != Some(r.agent_id.as_str());
    for row in rows
        .iter_mut()
        .filter(|r| r.kind != "step" || ran_as_agent(r))
    {
        let name = library
            .get(&row.agent_id)
            .and_then(|a| named(&a.name))
            .or_else(|| {
                own.iter()
                    .find(|h| h.id == row.agent_id)
                    .and_then(|h| named(&h.name))
            });
        if let Some(name) = name {
            row.name = name;
        }
    }
    Ok(rows)
}

/// Take `id` off the agents the chat assistant may hand work to; used when
/// the agent is deleted.
pub fn forget_handoff(state: &crate::state::AppState, id: &str) -> Result<(), String> {
    let mut agent = state.settings()?.agent;
    if !agent.handoff_agents.iter().any(|h| h == id) {
        return Ok(());
    }
    agent.handoff_agents.retain(|h| h != id);
    let mut patch: crate::state::SettingsPatch =
        serde_json::from_str("{}").map_err(|e| e.to_string())?;
    patch.agent = Some(agent.into());
    state.update_settings(patch).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedBy {
    pub workflow_id: String,
    pub workflow_name: String,
}

/// A helper that is just a reference to one of the user's agents.
pub fn reference(id: &str) -> AgentDef {
    AgentDef {
        id: id.to_string(),
        name: String::new(),
        instructions: String::new(),
        model: None,
        tools: Vec::new(),
        agents: Vec::new(),
        max_tokens: None,
        alongside: false,
        memory: false,
        knowledge: Vec::new(),
        library: Some(id.to_string()),
    }
}

/// Fill in every helper that refers to one of `library`'s agents, and add the
/// agents those hand work to (and so on) that the list doesn't have yet. A
/// reference to an agent that isn't in `library` is left as `{ id, library }`
/// (validation reports it). `helpers` keeps its order; additions go last.
pub fn resolve_helpers(library: &HashMap<String, AgentDef>, helpers: &mut Vec<AgentDef>) {
    // An inline helper that happens to share an id doesn't count: both stay,
    // and validation reports the duplicate.
    let mut present: HashSet<String> = helpers
        .iter()
        .filter(|h| h.library.is_some())
        .map(|h| h.id.clone())
        .collect();
    let mut at = 0;
    while at < helpers.len() {
        let source = helpers[at]
            .library
            .as_deref()
            .and_then(|id| library.get(id))
            .cloned();
        if let Some(source) = source {
            let helper = &mut helpers[at];
            helper.name = source.name;
            helper.instructions = source.instructions;
            helper.model = source.model;
            helper.tools = source.tools;
            helper.max_tokens = source.max_tokens;
            helper.alongside = source.alongside;
            helper.memory = source.memory;
            helper.knowledge = source.knowledge;
            for next in &source.agents {
                if present.insert(next.clone()) {
                    helpers.push(reference(next));
                }
            }
            helpers[at].agents = source.agents;
        }
        at += 1;
    }
}

/// [`resolve_helpers`] on a workflow's helpers. An agent step that runs as
/// one of the user's agents adds that agent to the helpers (as a reference,
/// when it isn't there yet) and then takes its model, tools and helpers
/// ([`apply_step_agents`]).
pub fn resolve_with(library: &HashMap<String, AgentDef>, def: &mut WorkflowDefinition) {
    for id in step_agents(def) {
        if !def.agents.iter().any(|h| h.id == id) {
            def.agents.push(reference(&id));
        }
    }
    if def.agents.iter().any(|h| h.library.is_some()) {
        resolve_helpers(library, &mut def.agents);
    }
    apply_step_agents(def);
}

/// Whether `def` refers to any of the user's agents, as a helper or as the
/// agent a step runs as.
pub fn refers_to_library(def: &WorkflowDefinition) -> bool {
    def.agents.iter().any(|h| h.library.is_some()) || !step_agents(def).is_empty()
}

/// Every agent in the library by id.
pub async fn load(
    pool: &SqlitePool,
    enc: &Encryption,
) -> Result<HashMap<String, AgentDef>, String> {
    Ok(repo::list(pool, enc)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| (r.agent.id.clone(), r.agent))
        .collect())
}

/// Fill in `def`'s references to the user's agents (see [`resolve_helpers`]).
/// Call it on a copy, before checking or running; saving keeps the references.
pub async fn resolve(
    pool: &SqlitePool,
    enc: &Encryption,
    def: &mut WorkflowDefinition,
) -> Result<(), String> {
    if !refers_to_library(def) {
        return Ok(());
    }
    let library = load(pool, enc).await?;
    resolve_with(&library, def);
    Ok(())
}

/// [`resolve`] on a raw definition, for the paths that check JSON as the
/// renderer sent it. Only the helpers change: entries that are not references
/// stay exactly as written (so unknown settings are still reported), and a
/// definition that can't be read comes back as it was, for the usual checks
/// to report.
pub async fn resolve_value(
    pool: &SqlitePool,
    enc: &Encryption,
    definition: &Value,
) -> Result<Value, String> {
    let Ok(mut parsed) = serde_json::from_value::<WorkflowDefinition>(definition.clone()) else {
        return Ok(definition.clone());
    };
    let own = parsed.agents.len();
    resolve(pool, enc, &mut parsed).await?;
    if parsed.agents.iter().all(|h| h.library.is_none()) {
        return Ok(definition.clone());
    }
    let mut list: Vec<Value> = definition
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (at, helper) in parsed.agents.iter().enumerate() {
        let filled = serde_json::to_value(helper).map_err(|e| e.to_string())?;
        if at >= own {
            list.push(filled);
        } else if helper.library.is_some() {
            list[at] = filled;
        }
    }
    let mut out = definition.clone();
    if let Some(object) = out.as_object_mut() {
        object.insert("agents".to_string(), Value::Array(list));
    }
    Ok(out)
}

/// The helpers of a raw definition as a run sees them, read leniently: an
/// entry that can't be read is left out.
pub async fn resolve_value_helpers(
    pool: &SqlitePool,
    enc: &Encryption,
    definition: &Value,
) -> Result<Vec<AgentDef>, String> {
    let mut helpers: Vec<AgentDef> = definition
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|h| serde_json::from_value(h.clone()).ok())
        .collect();
    if helpers.iter().any(|h| h.library.is_some()) {
        let library = load(pool, enc).await?;
        resolve_helpers(&library, &mut helpers);
    }
    Ok(helpers)
}

/// Every problem with `agent` as a library agent, in plain English, or `Ok`
/// when it can be saved. `library` is the other agents (a copy of `agent`
/// under its own id is ignored).
pub fn check(agent: &AgentDef, library: &[AgentDef]) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    check_helper_id(agent, &mut problems);
    check_helper_fields(agent, &mut problems);
    let others: Vec<&AgentDef> = library.iter().filter(|a| a.id != agent.id).collect();
    let who = quoted(agent);
    if agent.library.is_some() {
        problems.push(format!(
            "{who} can't be a copy of another agent; give it its own instructions."
        ));
    }
    let mut seen = HashSet::new();
    for id in &agent.agents {
        if id == &agent.id {
            problems.push(format!("{who} can\u{2019}t hand work to itself."));
        } else if !others.iter().any(|a| &a.id == id) {
            problems.push(format!(
                "{who} hands work to \u{201c}{id}\u{201d}, which isn\u{2019}t one of your agents."
            ));
        }
        if !seen.insert(id) {
            problems.push(format!("{who} lists an agent twice."));
        }
    }
    if agent.agents.len() > MAX_HELPERS_PER_AGENT {
        problems.push(format!(
            "{who} can hand work to at most {MAX_HELPERS_PER_AGENT} agents."
        ));
    }
    // A circle through this agent: follow the hand-offs until they lead back.
    if let Some(circle) = circle_through(agent, &others) {
        let names: Vec<String> = circle
            .iter()
            .map(|a| format!("\u{201c}{a}\u{201d}"))
            .collect();
        problems.push(format!(
            "The agents {} hand work to each other in a circle; one of them has to stop handing it on.",
            names.join(", ")
        ));
    }
    // An agent used as a helper is already one hand-off deep and work is
    // handed on at most `MAX_HANDOFF_DEPTH` (2) times, so the helpers an agent
    // hands work to may not hand it on again.
    let on_again = "An agent\u{2019}s helpers can\u{2019}t have helpers of their own.";
    for id in &agent.agents {
        if let Some(helper) = others.iter().find(|a| &a.id == id) {
            if !helper.agents.is_empty() {
                problems.push(format!(
                    "{who} hands work to {}, which hands work on too. {on_again}",
                    quoted(helper)
                ));
            }
        }
    }
    if !agent.agents.is_empty() {
        for user in others.iter().filter(|a| a.agents.contains(&agent.id)) {
            problems.push(format!(
                "{} hands work to {who}, which hands work on too. {on_again}",
                quoted(user)
            ));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// The agent's name in curly quotes, by id until it has one.
fn quoted(agent: &AgentDef) -> String {
    let name = agent.name.trim();
    format!(
        "\u{201c}{}\u{201d}",
        if name.is_empty() { &agent.id } else { name }
    )
}

/// The names of the agents in a circle of hand-offs that `agent` is part of.
fn circle_through(agent: &AgentDef, others: &[&AgentDef]) -> Option<Vec<String>> {
    fn walk<'a>(
        at: &'a AgentDef,
        start: &str,
        others: &[&'a AgentDef],
        path: &mut Vec<&'a AgentDef>,
        visited: &mut HashSet<String>,
    ) -> bool {
        path.push(at);
        for next in &at.agents {
            if next == start {
                return true;
            }
            if !visited.insert(next.clone()) {
                continue;
            }
            if let Some(found) = others.iter().find(|a| &a.id == next) {
                if walk(found, start, others, path, visited) {
                    return true;
                }
            }
        }
        path.pop();
        false
    }
    let mut path = Vec::new();
    let mut visited = HashSet::new();
    walk(agent, &agent.id, others, &mut path, &mut visited).then(|| {
        path.iter()
            .map(|a| {
                let name = a.name.trim();
                if name.is_empty() { &a.id } else { name }.to_string()
            })
            .collect()
    })
}

/// The id for a new agent named `name`: lowercase ASCII letters and digits
/// with other runs as `_`, at most 40 characters, `agent` for nothing usable.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('_');
            }
            gap = false;
            out.push(c.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    out.truncate(MAX_ID_CHARS);
    let out = out.trim_end_matches('_');
    if out.is_empty() {
        "agent".to_string()
    } else {
        out.to_string()
    }
}

/// `base`, or `base_2`, `base_3`... when taken.
pub fn unique_id(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| {
            let suffix = format!("_{n}");
            let keep = MAX_ID_CHARS - suffix.len();
            let cut: String = base.chars().take(keep).collect();
            format!("{}{suffix}", cut.trim_end_matches('_'))
        })
        .find(|id| !taken.contains(id))
        .expect("an unused id exists")
}

/// What the Agents page and the editor send for a new agent: the id made
/// from the name when empty, the text trimmed.
fn prepared(mut agent: AgentDef, taken: &HashSet<String>) -> AgentDef {
    agent.name = agent.name.trim().to_string();
    agent.instructions = agent.instructions.trim().to_string();
    agent.id = agent.id.trim().to_string();
    for collection in &mut agent.knowledge {
        *collection = collection.trim().to_string();
    }
    if agent.id.is_empty() {
        agent.id = unique_id(&slug(&agent.name), taken);
    }
    agent
}

/// The collections `agent` reads that aren't among the user's collections
/// of documents, as problems (like a helper that isn't one of the agents).
pub async fn check_knowledge(pool: &SqlitePool, agent: &AgentDef) -> Result<Vec<String>, String> {
    let listed: Vec<&str> = agent
        .knowledge
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();
    if listed.is_empty() {
        return Ok(Vec::new());
    }
    let known: HashSet<String> = knowledge::list_collections(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| c.id)
        .collect();
    let who = quoted(agent);
    Ok(listed
        .into_iter()
        .filter(|id| !known.contains(*id))
        .map(|id| {
            format!(
                "{who} reads \u{201c}{id}\u{201d}, which isn\u{2019}t one of your collections of documents."
            )
        })
        .collect())
}

/// [`check`] and [`check_knowledge`] together.
async fn problems(
    pool: &SqlitePool,
    agent: &AgentDef,
    others: &[AgentDef],
) -> Result<Vec<String>, String> {
    let mut problems = check(agent, others).err().unwrap_or_default();
    problems.extend(check_knowledge(pool, agent).await?);
    Ok(problems)
}

/// Everything wrong with `agent` as a library agent; empty when it can be
/// saved. An empty id counts as the one it would be given.
pub async fn validate(
    pool: &SqlitePool,
    enc: &Encryption,
    agent: AgentDef,
) -> Result<Vec<String>, String> {
    let library = load(pool, enc).await?;
    let taken = library.keys().cloned().collect();
    let agent = if agent.id.trim().is_empty() {
        prepared(agent, &taken)
    } else {
        agent
    };
    let others: Vec<AgentDef> = library.into_values().collect();
    problems(pool, &agent, &others).await
}

/// Fail with the problems, one per line, when there are any.
fn none_of(problems: Vec<String>) -> Result<(), String> {
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

/// Save a new agent. Errors are the problems, one per line.
pub async fn create(
    pool: &SqlitePool,
    enc: &Encryption,
    agent: AgentDef,
) -> Result<LibraryAgent, String> {
    let library = load(pool, enc).await?;
    let taken = library.keys().cloned().collect();
    let agent = prepared(agent, &taken);
    // A named id that is taken gets a suffix as an empty one does.
    let agent = if library.contains_key(&agent.id) {
        AgentDef {
            id: unique_id(&agent.id, &taken),
            ..agent
        }
    } else {
        agent
    };
    let others: Vec<AgentDef> = library.into_values().collect();
    none_of(problems(pool, &agent, &others).await?)?;
    let saved = repo::insert(pool, enc, &agent)
        .await
        .map_err(|e| e.to_string())?;
    entry(pool, enc, saved).await
}

/// Save changes to an agent that exists.
pub async fn update(
    pool: &SqlitePool,
    enc: &Encryption,
    agent: AgentDef,
) -> Result<LibraryAgent, String> {
    let library = load(pool, enc).await?;
    if !library.contains_key(agent.id.trim()) {
        return Err("That agent no longer exists.".to_string());
    }
    let agent = prepared(agent, &HashSet::new());
    let others: Vec<AgentDef> = library.into_values().collect();
    none_of(problems(pool, &agent, &others).await?)?;
    let saved = repo::update(pool, enc, &agent)
        .await
        .map_err(|e| e.to_string())?;
    entry(pool, enc, saved).await
}

async fn entry(
    pool: &SqlitePool,
    enc: &Encryption,
    record: repo::AgentRecord,
) -> Result<LibraryAgent, String> {
    let mut used = used_by(pool, enc).await?;
    let notes = memory::count_in(pool, &memory::agent_scope(&record.agent.id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(LibraryAgent {
        used_by: used.remove(&record.agent.id).unwrap_or_default(),
        agent: record.agent,
        created_at: record.created_at,
        updated_at: record.updated_at,
        chat: ChatUse::default(),
        notes: notes.max(0) as u64,
    })
}

/// Every agent, by name, with the workflows that use it.
pub async fn list(pool: &SqlitePool, enc: &Encryption) -> Result<Vec<LibraryAgent>, String> {
    let mut used = used_by(pool, enc).await?;
    let notes = memory::agent_note_counts(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Vec<LibraryAgent> = repo::list(pool, enc)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| LibraryAgent {
            used_by: used.remove(&r.agent.id).unwrap_or_default(),
            notes: notes.get(&r.agent.id).copied().unwrap_or(0).max(0) as u64,
            agent: r.agent,
            created_at: r.created_at,
            updated_at: r.updated_at,
            chat: ChatUse::default(),
        })
        .collect();
    out.sort_by_cached_key(|a| (a.agent.name.to_lowercase(), a.agent.id.clone()));
    Ok(out)
}

/// For each library agent, the workflows whose helpers include it once
/// resolved (directly or through another agent).
async fn used_by(
    pool: &SqlitePool,
    enc: &Encryption,
) -> Result<HashMap<String, Vec<UsedBy>>, String> {
    let library = load(pool, enc).await?;
    let mut out: HashMap<String, Vec<UsedBy>> = HashMap::new();
    if library.is_empty() {
        return Ok(out);
    }
    for (id, name, definition) in repo::workflow_definitions(pool, enc)
        .await
        .map_err(|e| e.to_string())?
    {
        let Ok(mut def) = serde_json::from_value::<WorkflowDefinition>(definition) else {
            continue;
        };
        resolve_with(&library, &mut def);
        let mut seen = HashSet::new();
        for library_id in def.agents.iter().filter_map(|h| h.library.as_deref()) {
            if library.contains_key(library_id) && seen.insert(library_id.to_string()) {
                out.entry(library_id.to_string()).or_default().push(UsedBy {
                    workflow_id: id.clone(),
                    workflow_name: name.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// Delete an agent. A workflow that has it as a helper gets its own copy
/// (same id, no `library`), and the agents it hands work to stay helpers of
/// that workflow; other agents stop handing work to it. All or nothing.
/// Returns how many workflows were changed.
pub async fn delete(pool: &SqlitePool, enc: &Encryption, id: &str) -> Result<u32, String> {
    let library = load(pool, enc).await?;
    let Some(gone) = library.get(id).cloned() else {
        return Err("That agent no longer exists.".to_string());
    };
    // Its notes go with it, so the copy doesn't remember; it still reads
    // the same collections.
    let copy = AgentDef {
        library: None,
        memory: false,
        ..gone
    };
    let mut changes = Vec::new();
    for (workflow_id, _, mut definition) in repo::workflow_definitions(pool, enc)
        .await
        .map_err(|e| e.to_string())?
    {
        let Some(list) = definition.get_mut("agents").and_then(Value::as_array_mut) else {
            continue;
        };
        let refers = |h: &Value| h.get("library").and_then(Value::as_str) == Some(id);
        if !list.iter().any(refers) {
            continue;
        }
        let mut present: HashSet<String> = list
            .iter()
            .filter_map(|h| h.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        for helper in list.iter_mut().filter(|h| refers(h)) {
            let own_id = helper
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string();
            *helper = serde_json::to_value(AgentDef {
                id: own_id,
                ..copy.clone()
            })
            .map_err(|e| e.to_string())?;
        }
        // What the copy hands work to is still reached through the library.
        for next in &copy.agents {
            if present.insert(next.clone()) {
                list.push(serde_json::json!({ "id": next, "library": next }));
            }
        }
        changes.push((workflow_id, definition));
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (workflow_id, definition) in &changes {
        repo::replace_workflow_definition(&mut tx, enc, workflow_id, definition)
            .await
            .map_err(|e| e.to_string())?;
    }
    for other in library
        .values()
        .filter(|a| a.agents.iter().any(|n| n == id))
    {
        let mut other = other.clone();
        other.agents.retain(|n| n != id);
        repo::update_in(&mut tx, enc, &other)
            .await
            .map_err(|e| e.to_string())?;
    }
    repo::delete_in(&mut tx, id)
        .await
        .map_err(|e| e.to_string())?;
    memory::delete_scope_in(&mut tx, &memory::agent_scope(id))
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(changes.len() as u32)
}

/// The agents a new profile starts with: (id, name, instructions, tools).
const STARTERS: &[(&str, &str, &str, &[&str])] = &[
    (
        "researcher",
        "Researcher",
        "Find out what you are asked about on the web. Search, read the most relevant pages, and answer with the facts you found, each with the page it came from. Say plainly when sources disagree or you couldn\u{2019}t find something.",
        &["web_search", "web_fetch"],
    ),
    (
        "writer",
        "Writer",
        "Write what you are asked for from the material you are given: clear, plain and well organised, in the length and tone asked for. Don\u{2019}t add facts that aren\u{2019}t in the material.",
        &[],
    ),
    (
        "reviewer",
        "Reviewer",
        "Check the work you are given against what was asked for. List what is wrong or missing \u{2014} facts that look doubtful, claims without a source, parts of the request it skips \u{2014} most important first. Don\u{2019}t rewrite it; say what to change.",
        &["web_search", "web_fetch"],
    ),
    (
        "analyst",
        "Data analyst",
        "Work through the numbers you are given: totals, averages, changes, comparisons. Show each calculation, then state what the numbers say in plain words. Ask for the data you need rather than guessing it.",
        &["calculator"],
    ),
];

/// The starter agents as definitions.
pub fn starters() -> Vec<AgentDef> {
    STARTERS
        .iter()
        .map(|(id, name, instructions, tools)| AgentDef {
            id: id.to_string(),
            name: name.to_string(),
            instructions: instructions.to_string(),
            model: None,
            tools: tools.iter().map(|t| t.to_string()).collect(),
            agents: Vec::new(),
            max_tokens: None,
            alongside: false,
            memory: false,
            knowledge: Vec::new(),
            library: None,
        })
        .collect()
}

/// Add the starter agents once, ever: the first time Conduit starts with
/// this feature. An agent whose id is already there is skipped, and the user
/// deleting them later doesn't bring them back. Returns how many were added.
pub async fn seed_starters(pool: &SqlitePool, enc: &Encryption) -> Result<usize, String> {
    if repo::starters_offered(pool)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(0);
    }
    let mut added = 0;
    for agent in starters() {
        if repo::get(pool, enc, &agent.id)
            .await
            .map_err(|e| e.to_string())?
            .is_none()
        {
            repo::insert(pool, enc, &agent)
                .await
                .map_err(|e| e.to_string())?;
            added += 1;
        }
    }
    repo::mark_starters_offered(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(added)
}
