//! Outside actions: a step calling a connector tool that changes things (sends
//! a message, files an issue, books a meeting).
//!
//! The run stops and shows the exact call — the connector, the tool and its
//! arguments — and goes ahead only when the user says Send (after changing the
//! arguments, if they like). The user decides, per workflow, which actions may
//! go ahead without asking, or that all may ([`ActionRules`]); a tool that
//! declares itself sensitive always asks. The wait works like an "Ask me" step
//! (`waiting`): the run shows as paused, the Inbox and the workflow's page list
//! it, and nobody answering in time counts as Don't send.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::waiting::{Pending, Waiting};

/// A run waiting for the user to check an outside action.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub step_id: String,
    pub connector_id: String,
    pub connector_name: String,
    pub tool: String,
    /// What the connector says the tool does.
    pub description: Option<String>,
    /// The call's arguments, exactly as they would be sent.
    pub arguments: Value,
    /// The tool's JSON Schema for its arguments (the Edit form).
    pub input_schema: Value,
    /// The tool says it is sensitive: it always asks, and "don't ask again"
    /// isn't offered.
    pub sensitive: bool,
    pub requested_at: String,
    pub expires_at: String,
    /// Set when the action is the agent using the computer (a command or a
    /// file change) rather than a connector tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computer: Option<ComputerRequest>,
}

/// A command or file change waiting for the user, as the card shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerRequest {
    /// `run_command`, `write_file` or `edit_file`.
    pub kind: String,
    /// The workflow's folder.
    pub folder: String,
    /// A command: the program as found on this computer, and its arguments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Where a command runs, or the file a change is to, inside the folder.
    pub path: String,
    /// A file change: the new content, and the old one when the file exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    /// What the agent said it's for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// Why this asks rather than going ahead.
    pub reason: String,
    /// What the agent read from outside before this, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_before: Option<String>,
    /// The rule "Allow from now on" would add; `None` when it isn't offered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_rule: Option<String>,
    /// It matched an always-ask rule or the built-in list (it deletes files,
    /// throws work away...): the card warns and doesn't make Run the default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub risky: bool,
    /// What this step already did on the computer, oldest first (commands
    /// and file changes as run details record them, without their output).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub so_far: Vec<Value>,
    /// The command already ran kept in the folder and failed, apparently
    /// because of that: the card offers to run this one command outside the
    /// folder (never remembered, never editable).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outside: Option<OutsideOffer>,
}

/// Why a kept-in command failed, and the end of what it printed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideOffer {
    pub cause: super::computer::KeptInFailure,
    pub output: String,
}

impl Pending for PendingAction {
    fn run_id(&self) -> &str {
        &self.run_id
    }
    fn step_id(&self) -> &str {
        &self.step_id
    }
    fn requested_at(&self) -> &str {
        &self.requested_at
    }
}

/// The user's answer to a [`PendingAction`].
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionAnswer {
    pub send: bool,
    /// The arguments the user changed; `None` sends them as they were.
    #[serde(default)]
    pub arguments: Option<Value>,
    /// Don't ask again for this tool in this workflow (ignored for a
    /// sensitive tool, and when not sending).
    #[serde(default)]
    pub remember: bool,
    /// For a command: the rule to remember (the suggested one, perhaps
    /// edited); ignored unless `remember`.
    #[serde(default)]
    pub rule: Option<String>,
}

/// Runs waiting for the user to check an outside action, by run id and step id.
pub type Actions = Waiting<PendingAction, ActionAnswer>;

/// An action allowed to go ahead without asking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedAction {
    pub connector_id: String,
    /// The connector's name when it was allowed, for the list.
    pub connector_name: String,
    pub tool: String,
}

/// Which of a workflow's outside actions go ahead without asking.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRules {
    /// Every action goes ahead without asking (except sensitive ones). Never
    /// covers commands: only `commands` does.
    pub allow_all: bool,
    pub allowed: Vec<AllowedAction>,
    /// Which commands the workflow's agents run without asking, and which
    /// always ask.
    #[serde(default)]
    pub commands: super::computer::CommandRules,
}

impl ActionRules {
    /// Whether `tool` on `connector_id` may go ahead without asking.
    pub fn allows(&self, connector_id: &str, tool: &str, sensitive: bool) -> bool {
        !sensitive
            && (self.allow_all
                || self
                    .allowed
                    .iter()
                    .any(|a| a.connector_id == connector_id && a.tool == tool))
    }

    /// Allow `action` without asking from now on; `false` when it already was.
    pub fn allow(&mut self, action: AllowedAction) -> bool {
        let known = self
            .allowed
            .iter()
            .any(|a| a.connector_id == action.connector_id && a.tool == action.tool);
        if !known {
            self.allowed.push(action);
        }
        !known
    }
}

/// How an outside action ended, as the step's output records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// The user said Send.
    Sent,
    /// The workflow's rules let it go ahead without asking.
    SentWithoutAsking,
    /// The user said Don't send, or nobody answered in time.
    NotSent,
    /// It was sent, and the connector reported an error.
    Failed,
}

/// One outside action in a step's output.
pub fn record(
    connector_id: &str,
    connector_name: &str,
    tool: &str,
    arguments: &Value,
    outcome: Outcome,
    error: Option<&str>,
) -> Value {
    let mut entry = serde_json::json!({
        "connector": { "id": connector_id, "name": connector_name },
        "tool": tool,
        "arguments": arguments,
        "outcome": outcome,
    });
    if let Some(error) = error {
        entry["error"] = Value::String(error.to_string());
    }
    entry
}

/// Arguments the user edited, checked: still a set of named values.
pub fn checked_arguments(arguments: Value) -> Result<Value, String> {
    if arguments.is_object() {
        Ok(arguments)
    } else {
        Err("The changed arguments should be a set of named values.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn allowed(connector: &str, tool: &str) -> AllowedAction {
        AllowedAction {
            connector_id: connector.into(),
            connector_name: "Notes".into(),
            tool: tool.into(),
        }
    }

    #[test]
    fn rules_allow_listed_actions_and_never_sensitive_ones() {
        let mut rules = ActionRules::default();
        assert!(!rules.allows("c1", "add_note", false));
        assert!(rules.allow(allowed("c1", "add_note")));
        assert!(!rules.allow(allowed("c1", "add_note")));
        assert_eq!(rules.allowed.len(), 1);
        assert!(rules.allows("c1", "add_note", false));
        assert!(!rules.allows("c1", "add_note", true));
        assert!(!rules.allows("c2", "add_note", false));
        rules.allow_all = true;
        assert!(rules.allows("c2", "delete_note", false));
        assert!(!rules.allows("c2", "delete_note", true));
    }

    #[test]
    fn an_answer_defaults_to_the_arguments_as_they_were() {
        let answer: ActionAnswer = serde_json::from_value(json!({ "send": true })).unwrap();
        assert_eq!(
            answer,
            ActionAnswer {
                send: true,
                arguments: None,
                remember: false,
                rule: None,
            }
        );
        assert!(checked_arguments(json!({ "text": "hi" })).is_ok());
        assert!(checked_arguments(json!("hi")).is_err());
    }

    #[test]
    fn a_record_names_the_connector_tool_and_outcome() {
        let entry = record(
            "c1",
            "Notes",
            "add_note",
            &json!({ "text": "hi" }),
            Outcome::SentWithoutAsking,
            None,
        );
        assert_eq!(entry["outcome"], "sentWithoutAsking");
        assert_eq!(entry["connector"]["name"], "Notes");
        assert!(entry.get("error").is_none());
    }
}
