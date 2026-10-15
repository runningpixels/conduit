//! What a run produced: the documents, decks, drafts and files its steps
//! saved, read from the step records once when the run ends and kept on the
//! run (`workflow_runs.result_json`), so the Results list, the workflow page and
//! Home can show "Open" without decrypting every step.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::repository::workflows::WorkflowRunStep;

/// Longest preview kept per output, in characters.
pub const PREVIEW_CHARS: usize = 320;

/// One thing a run saved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    /// `document`, `deck`, `draft` or `file`.
    pub kind: String,
    pub title: String,
    /// The step that saved it.
    pub step_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    /// Where a document lives (the workflow's own conversation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<String>,
    /// For a file: where it was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The start of what was saved, as plain text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// A save that found the same content as last time and kept it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
}

/// The outputs recorded in `steps`, once each, in the order they were saved.
/// `conversation_id` is the workflow's conversation, for a document whose step
/// output doesn't name one. Steps that didn't complete are left out.
pub fn collect(steps: &[WorkflowRunStep], conversation_id: Option<&str>) -> Vec<RunOutput> {
    let mut outputs: Vec<RunOutput> = Vec::new();
    for step in steps {
        if !matches!(step.status.as_str(), "completed" | "reused") {
            continue;
        }
        let (Some(out), input) = (step.output.as_ref(), step.input.as_ref()) else {
            continue;
        };
        let saved = from_step(&step.step_id, out, input, conversation_id);
        for output in saved
            .into_iter()
            .chain(computer_changes(&step.step_id, out))
        {
            // A loop that saves into the same document each time is one output:
            // keep the last save (its preview is what the document now holds).
            if let Some(same) = outputs.iter_mut().find(|o| o.same_target(&output)) {
                *same = output;
            } else {
                outputs.push(output);
            }
        }
    }
    outputs
}

impl RunOutput {
    fn same_target(&self, other: &RunOutput) -> bool {
        self.kind == other.kind
            && match self.kind.as_str() {
                "document" => self.artifact_id == other.artifact_id,
                "deck" => self.deck_id == other.deck_id,
                "draft" => self.draft_id == other.draft_id,
                _ => self.path == other.path,
            }
    }

    fn new(kind: &str, title: String, step_id: &str) -> Self {
        Self {
            kind: kind.to_string(),
            title,
            step_id: step_id.to_string(),
            artifact_id: None,
            conversation_id: None,
            deck_id: None,
            draft_id: None,
            path: None,
            preview: None,
            unchanged: false,
        }
    }
}

fn text<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn from_step(
    step_id: &str,
    out: &Value,
    input: Option<&Value>,
    conversation_id: Option<&str>,
) -> Option<RunOutput> {
    let input_title = input.and_then(|i| text(i, "title"));
    if let Some(artifact_id) = text(out, "artifactId") {
        let title = text(out, "title").or(input_title).unwrap_or("Document");
        let mut output = RunOutput::new("document", title.to_string(), step_id);
        output.artifact_id = Some(artifact_id.to_string());
        output.conversation_id = text(out, "conversationId")
            .or(conversation_id)
            .map(str::to_string);
        output.preview = input.and_then(|i| text(i, "content")).and_then(preview);
        output.unchanged = out.get("unchanged").and_then(Value::as_bool) == Some(true);
        return Some(output);
    }
    for (kind, key) in [("deck", "deckId"), ("draft", "draftId")] {
        if let Some(id) = text(out, key) {
            let title = text(out, "title").unwrap_or(if kind == "deck" { "Deck" } else { "Draft" });
            let mut output = RunOutput::new(kind, title.to_string(), step_id);
            if kind == "deck" {
                output.deck_id = Some(id.to_string());
            } else {
                output.draft_id = Some(id.to_string());
            }
            output.preview = text(out, "reply").and_then(preview);
            output.unchanged = out
                .get("changed")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
            return Some(output);
        }
    }
    if let (Some(path), Some(name)) = (text(out, "path"), text(out, "name")) {
        // `export_file`'s output; a `read_file` step outputs `path` too, but
        // with no `bytes`.
        if out.get("bytes").is_some() && input.and_then(|i| text(i, "type")) != Some("read_file") {
            let mut output = RunOutput::new("file", name.to_string(), step_id);
            output.path = Some(path.to_string());
            output.preview = input.and_then(|i| text(i, "content")).and_then(preview);
            return Some(output);
        }
    }
    None
}

/// The files an agent wrote or changed in the workflow's folder (its
/// `computer` record), by their path in the folder.
fn computer_changes(step_id: &str, out: &Value) -> Vec<RunOutput> {
    let Some(records) = out.get("computer").and_then(Value::as_array) else {
        return Vec::new();
    };
    records
        .iter()
        .filter(|r| {
            matches!(text(r, "kind"), Some("write" | "edit"))
                && text(r, "outcome") == Some("changed")
        })
        .filter_map(|r| text(r, "path"))
        .map(|path| {
            let mut output = RunOutput::new("file", path.to_string(), step_id);
            output.path = Some(path.to_string());
            output
        })
        .collect()
}

/// The start of `content` as one line of plain text: Markdown headings,
/// emphasis and link targets dropped, whitespace collapsed, cut at a word.
pub fn preview(content: &str) -> Option<String> {
    let mut words: Vec<&str> = Vec::new();
    let mut length = 0;
    'lines: for line in content.lines() {
        let line = line.trim();
        // A heading is a title the list already shows; skip it.
        if line.starts_with('#') || line.starts_with("```") || line.starts_with('|') {
            continue;
        }
        let line = line.trim_start_matches(['-', '*', '>', ' ']);
        for word in line.split_whitespace() {
            words.push(word);
            length += word.chars().count() + 1;
            if length > PREVIEW_CHARS {
                break 'lines;
            }
        }
    }
    let joined = words.join(" ");
    let cleaned = strip_markdown(&joined);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.chars().count() <= PREVIEW_CHARS {
        return Some(cleaned.to_string());
    }
    let cut: String = cleaned.chars().take(PREVIEW_CHARS).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    Some(format!(
        "{}\u{2026}",
        cut.trim_end_matches([',', ';', ':', '.'])
    ))
}

/// `[label](url)` becomes `label`; `*`, `_` and backticks used for emphasis go.
fn strip_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '`' => {}
            '_' if out.ends_with(' ') || out.is_empty() || chars.peek() == Some(&' ') => {}
            ']' if chars.peek() == Some(&'(') => {
                // Skip the link target.
                for next in chars.by_ref() {
                    if next == ')' {
                        break;
                    }
                }
            }
            '[' => {}
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(id: &str, status: &str, input: Value, output: Value) -> WorkflowRunStep {
        WorkflowRunStep {
            id: format!("row-{id}"),
            run_id: "run".into(),
            step_id: id.into(),
            iteration: None,
            status: status.into(),
            input: Some(input),
            output: Some(output),
            error: None,
            started_at: "2026-10-11T07:30:00Z".into(),
            finished_at: None,
        }
    }

    #[test]
    fn collects_a_saved_document_with_a_preview() {
        let steps = vec![
            step(
                "fetch",
                "completed",
                json!({"type": "fetch_page"}),
                json!({"pages": [], "text": "x"}),
            ),
            step(
                "save",
                "completed",
                json!({"type": "save_artifact", "title": "Briefing", "content": "# Briefing\n\nDeno is **joining** [Cloudflare](https://x.test).\n- Oxide raised money"}),
                json!({"artifactId": "a1", "title": "Briefing", "conversationId": "c1"}),
            ),
        ];
        let outputs = collect(&steps, Some("c0"));
        assert_eq!(outputs.len(), 1);
        let doc = &outputs[0];
        assert_eq!(doc.kind, "document");
        assert_eq!(doc.artifact_id.as_deref(), Some("a1"));
        assert_eq!(doc.conversation_id.as_deref(), Some("c1"));
        assert_eq!(
            doc.preview.as_deref(),
            Some("Deno is joining Cloudflare. Oxide raised money")
        );
        assert!(!doc.unchanged);
    }

    #[test]
    fn an_unchanged_save_takes_its_title_from_the_input_and_the_workflow_conversation() {
        let steps = vec![step(
            "save",
            "completed",
            json!({"type": "save_artifact", "title": "Prices", "content": "same"}),
            json!({"artifactId": "a1", "unchanged": true, "hash": "h"}),
        )];
        let outputs = collect(&steps, Some("c0"));
        assert_eq!(outputs[0].title, "Prices");
        assert_eq!(outputs[0].conversation_id.as_deref(), Some("c0"));
        assert!(outputs[0].unchanged);
    }

    #[test]
    fn one_entry_per_target_and_failed_steps_are_left_out() {
        let save = |content: &str| {
            step(
                "save",
                "completed",
                json!({"type": "save_artifact", "title": "Log", "content": content}),
                json!({"artifactId": "a1", "title": "Log", "conversationId": "c1"}),
            )
        };
        let mut failed = save("never");
        failed.status = "failed".into();
        let steps = vec![
            save("first"),
            save("second"),
            failed,
            step(
                "deck",
                "completed",
                json!({"type": "edit_deck"}),
                json!({"deckId": "d1", "title": "Numbers", "changed": ["s1"], "reply": "Updated the chart."}),
            ),
            step(
                "export",
                "completed",
                json!({"type": "export_file", "name": "out.csv", "content": "a,b"}),
                json!({"path": "C:/x/out.csv", "name": "out.csv", "bytes": 3}),
            ),
            step(
                "read",
                "completed",
                json!({"type": "read_file", "path": "in.csv"}),
                json!({"path": "C:/x/in.csv", "name": "in.csv", "bytes": 3, "text": "a"}),
            ),
        ];
        let outputs = collect(&steps, None);
        let kinds: Vec<&str> = outputs.iter().map(|o| o.kind.as_str()).collect();
        assert_eq!(kinds, ["document", "deck", "file"]);
        assert_eq!(outputs[0].preview.as_deref(), Some("second"));
        assert_eq!(outputs[1].deck_id.as_deref(), Some("d1"));
        assert_eq!(outputs[1].preview.as_deref(), Some("Updated the chart."));
        assert_eq!(outputs[2].path.as_deref(), Some("C:/x/out.csv"));
    }

    #[test]
    fn files_an_agent_changed_are_outputs_once_each() {
        let steps = vec![step(
            "fix",
            "completed",
            json!({"type": "agent"}),
            json!({"text": "Fixed it.", "computer": [
                {"kind": "command", "program": "node", "args": ["test.js"], "outcome": "ran"},
                {"kind": "edit", "path": "price.js", "outcome": "changed"},
                {"kind": "edit", "path": "price.js", "outcome": "changed"},
                {"kind": "write", "path": "NOTES.md", "outcome": "declined"},
            ]}),
        )];
        let outputs = collect(&steps, None);
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].kind, "file");
        assert_eq!(outputs[0].path.as_deref(), Some("price.js"));
    }

    #[test]
    fn preview_cuts_long_text_at_a_word() {
        let long = "word ".repeat(200);
        let cut = preview(&long).unwrap();
        assert!(cut.ends_with('\u{2026}'));
        assert!(cut.chars().count() <= PREVIEW_CHARS + 1);
        assert_eq!(preview("# Only a heading"), None);
        assert_eq!(preview("snake_case stays"), Some("snake_case stays".into()));
    }
}
