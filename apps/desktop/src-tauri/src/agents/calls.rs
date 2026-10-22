//! Telling the page when an agent starts or ends a task.
//!
//! Every row of `agent_calls` starts and ends through `start_agent_call` and
//! `finish_agent_call`; their callers then [`announce`] the row, which reaches
//! the page as the `agent-call-changed` event (wired in `main`). Nobody
//! listening (tests, or before start-up finishes) is fine: the row is saved.

use std::collections::HashMap;
use std::sync::Mutex;

use sqlx::SqlitePool;

use crate::db::repository::agent_calls::{self, AgentCallChange};
use crate::encryption::Encryption;
use crate::state::AppState;
use crate::workflows::definition::{AgentDef, WorkflowDefinition};

/// Emitted with an [`AgentCallChange`] whenever an agent call starts or ends.
pub const AGENT_CALL_CHANGED_EVENT: &str = "agent-call-changed";

type Listener = Box<dyn Fn(&AgentCallChange) + Send + Sync>;

/// Where agent calls announce themselves.
#[derive(Default)]
pub struct AgentCalls {
    listener: Mutex<Option<Listener>>,
}

impl AgentCalls {
    pub fn set_listener(&self, listener: impl Fn(&AgentCallChange) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.listener.lock() {
            *slot = Some(Box::new(listener));
        }
    }

    pub fn changed(&self, change: &AgentCallChange) {
        if let Ok(slot) = self.listener.lock() {
            if let Some(listener) = slot.as_ref() {
                listener(change);
            }
        }
    }
}

/// The running calls, newest first, each named.
pub async fn running(pool: &SqlitePool, enc: &Encryption) -> Result<Vec<AgentCallChange>, String> {
    let mut rows = agent_calls::agent_call_changes(pool, enc, None)
        .await
        .map_err(|e| e.to_string())?;
    name_calls(pool, enc, &mut rows).await?;
    Ok(rows)
}

/// Tell the listener how the call `id` stands now. Failing to is only logged.
pub async fn announce(state: &AppState, id: &str) {
    if let Err(e) = try_announce(state, id).await {
        tracing::warn!(error = %e, "could not announce an agent's task");
    }
}

async fn try_announce(state: &AppState, id: &str) -> Result<(), String> {
    let mut rows = agent_calls::agent_call_changes(&state.db, &state.encryption, Some(id))
        .await
        .map_err(|e| e.to_string())?;
    name_calls(&state.db, &state.encryption, &mut rows).await?;
    if let Some(change) = rows.first() {
        state.agent_calls.changed(change);
    }
    Ok(())
}

/// Name each call as `library::agent_calls_of_run` does: by the user's agent
/// of that id, else by its workflow's own helper, else by its id.
async fn name_calls(
    pool: &SqlitePool,
    enc: &Encryption,
    rows: &mut [AgentCallChange],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let library = super::library::load(pool, enc).await?;
    let mut own: HashMap<String, Vec<AgentDef>> = HashMap::new();
    for workflow_id in rows.iter().filter_map(|r| r.workflow_id.as_ref()) {
        if own.contains_key(workflow_id) {
            continue;
        }
        let agents = crate::db::repository::workflows::get(pool, enc, workflow_id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|w| serde_json::from_value::<WorkflowDefinition>(w.definition).ok())
            .map(|def| def.agents)
            .unwrap_or_default();
        own.insert(workflow_id.clone(), agents);
    }
    let named = |name: &str| Some(name.trim().to_string()).filter(|n| !n.is_empty());
    for row in rows {
        let name = library
            .get(&row.agent_id)
            .and_then(|a| named(&a.name))
            .or_else(|| {
                own.get(row.workflow_id.as_deref()?)?
                    .iter()
                    .find(|h| h.id == row.agent_id)
                    .and_then(|h| named(&h.name))
            });
        if let Some(name) = name {
            row.name = name;
        }
    }
    Ok(())
}
