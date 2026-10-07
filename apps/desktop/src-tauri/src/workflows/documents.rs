//! Telling the page that a workflow changed a saved deck or draft, so an open
//! Slides or Writing view reloads it.
//!
//! The runner has no window of its own; like questions and reviews, it
//! announces through a registry the app wires to Tauri events at start-up
//! (`main`): [`DECK_CHANGED_EVENT`] with a [`DeckChanged`] payload and
//! [`DRAFT_CHANGED_EVENT`] with a [`DraftChanged`] one.

use std::sync::Mutex;

use serde::Serialize;

/// Emitted when a workflow's `edit_deck` step changed a deck.
pub const DECK_CHANGED_EVENT: &str = "workflow-deck-changed";
/// Emitted when a workflow's `edit_draft` step changed a draft.
pub const DRAFT_CHANGED_EVENT: &str = "workflow-draft-changed";

/// Payload of [`DECK_CHANGED_EVENT`]: `{ "deckId", "workflowName", "runId" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckChanged {
    pub deck_id: String,
    pub workflow_name: String,
    pub run_id: String,
}

/// Payload of [`DRAFT_CHANGED_EVENT`]: `{ "draftId", "workflowName", "runId" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftChanged {
    pub draft_id: String,
    pub workflow_name: String,
    pub run_id: String,
}

/// A document a workflow changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentChange {
    Deck(DeckChanged),
    Draft(DraftChanged),
}

type Listener = Box<dyn Fn(&DocumentChange) + Send + Sync>;

/// Where the runner announces changed documents. Nobody listening (tests, or
/// before start-up finishes) is fine: the change is already saved.
#[derive(Default)]
pub struct DocumentChanges {
    listener: Mutex<Option<Listener>>,
}

impl DocumentChanges {
    pub fn set_listener(&self, listener: impl Fn(&DocumentChange) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.listener.lock() {
            *slot = Some(Box::new(listener));
        }
    }

    pub fn announce(&self, change: DocumentChange) {
        if let Ok(slot) = self.listener.lock() {
            if let Some(listener) = slot.as_ref() {
                listener(&change);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn payloads_are_camel_case() {
        assert_eq!(
            serde_json::to_value(DeckChanged {
                deck_id: "d".into(),
                workflow_name: "Weekly".into(),
                run_id: "r".into()
            })
            .unwrap(),
            json!({ "deckId": "d", "workflowName": "Weekly", "runId": "r" })
        );
        assert_eq!(
            serde_json::to_value(DraftChanged {
                draft_id: "w".into(),
                workflow_name: "Monthly".into(),
                run_id: "r".into()
            })
            .unwrap(),
            json!({ "draftId": "w", "workflowName": "Monthly", "runId": "r" })
        );
    }
}
