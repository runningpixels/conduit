//! What a workflow is, as stored: a list of steps, each producing named outputs
//! that later steps read through templates (`{{steps.fetch.pages}}`).
//!
//! Steps are deliberately small and mostly deterministic. A model is only
//! called by `summarize`, with no tools, so text fetched from the web can shape
//! a summary but cannot make anything happen. Small local models also do much
//! better with one narrow job per call than with one long agent turn.
//!
//! [`validate`] runs before every save and every run, so a run never starts on
//! a definition that reads a step that doesn't exist yet.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::template;

/// Most steps a workflow may have, nested `for_each` bodies included.
pub const MAX_STEPS: usize = 50;
/// Most pages one `fetch_page` step may fetch.
pub const MAX_URLS_PER_FETCH: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    /// Values asked for when the workflow is run, read as `{{inputs.<id>}}`.
    #[serde(default)]
    pub inputs: Vec<InputDef>,
    /// The model every `summarize` and `agent` step uses unless it names its
    /// own; without one, the chat's active model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelChoice>,
    pub steps: Vec<Step>,
}

/// A provider and one of its models, chosen for a workflow or a step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDef {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// Referenced by later steps as `steps.<id>`. Lowercase letters, digits, `_`.
    pub id: String,
    #[serde(flatten)]
    pub action: StepAction,
    #[serde(default)]
    pub on_error: OnError,
    /// How many times to try again after a failure; `None` takes the step's
    /// default ([`StepAction::default_retries`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retries: Option<u32>,
    /// The model this step uses, on `summarize` and `agent` steps only;
    /// without one, the workflow's (or the chat's active) model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelChoice>,
}

/// Most retries a step may ask for.
pub const MAX_RETRIES: u32 = 5;
/// Tools an agent step may use: read-only built-ins that never stop to ask
/// for approval, so a run nobody is watching can't hang on one.
pub const AGENT_TOOLS: &[&str] = &["web_search", "web_fetch", "current_time", "calculator"];

/// Most choices an "Ask me" step offers, and the longest one.
pub const MAX_CHOICES: usize = 10;
pub const MAX_CHOICE_CHARS: usize = 80;

/// What a step does. Each field that holds text is a template.
///
/// Outputs, as later steps see them:
/// - `fetch_page`: `pages` (each `url, title, text, links, lookedEmpty, error`)
///   and `text` (all readable pages joined under their titles)
/// - `web_search`: `results` (the search backend's result objects)
/// - `summarize`: `text`, plus `data` (the parsed JSON) when `schema` is set
/// - `template`: `text`
/// - `for_each`: `items`, one object per element holding that iteration's step
///   outputs by step id
/// - `save_artifact`: `artifactId`
/// - `notify`: `delivered`
/// - `ask`: `answer`
/// - `agent`: `text` (its answer) and `toolCalls` (the tools it called)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StepAction {
    FetchPage {
        urls: Vec<String>,
    },
    WebSearch {
        query: String,
        #[serde(default)]
        max_results: Option<u32>,
    },
    Summarize {
        /// What to do with the input ("Summarize this in three bullets").
        prompt: String,
        /// The text to work on, usually a reference to an earlier step.
        input: String,
        /// When set, the model is asked for JSON of this shape and the parsed
        /// value is the step's `data` output.
        #[serde(default)]
        schema: Option<Value>,
    },
    Template {
        template: String,
    },
    ForEach {
        /// A path (not a template) to a list, e.g. `steps.fetch.pages`.
        items: String,
        steps: Vec<Step>,
    },
    SaveArtifact {
        title: String,
        content: String,
        #[serde(default)]
        format: ArtifactFormat,
        #[serde(default)]
        mode: SaveMode,
    },
    /// A model turn that may use a few read-only tools before answering.
    Agent {
        /// What to do ("Find this week's Rust release notes and list what changed").
        prompt: String,
        /// Text to work on, usually from an earlier step.
        #[serde(default)]
        input: String,
        /// Tools it may call, from [`AGENT_TOOLS`].
        #[serde(default)]
        tools: Vec<String>,
    },
    /// Stop and ask the user; the answer is the step's `answer`.
    Ask {
        question: String,
        /// Answers to pick from; empty for a typed answer. Not templates.
        #[serde(default)]
        choices: Vec<String>,
        /// Taken when nobody answers in time; without it the step fails.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    /// A desktop notification.
    Notify {
        title: String,
        #[serde(default)]
        body: String,
    },
}

impl StepAction {
    /// Retries when the step doesn't say: a network step twice (sites and
    /// search backends fail for a moment), a model call once, nothing else.
    pub fn default_retries(&self) -> u32 {
        match self {
            StepAction::FetchPage { .. } | StepAction::WebSearch { .. } => 2,
            StepAction::Summarize { .. } => 1,
            _ => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnError {
    /// Stop the run.
    #[default]
    Fail,
    /// Record the error as the step's output and carry on.
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactFormat {
    #[default]
    Markdown,
    Html,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveMode {
    /// Overwrite the workflow's artifact with this title, or create it.
    #[default]
    Update,
    /// A new artifact every run.
    Create,
}

/// Parse a stored definition. Lenient: keys it doesn't know are ignored, so a
/// stored workflow always loads; [`unknown_settings`] is what flags them.
pub fn parse(json: &str) -> Result<WorkflowDefinition, String> {
    serde_json::from_str(json).map_err(|e| unreadable(&e))
}

/// "The workflow definition can't be read: ..." with serde's wording made plain.
pub fn unreadable(error: &serde_json::Error) -> String {
    format!(
        "The workflow definition can't be read: {}",
        plain_parse_error(&error.to_string())
    )
}

/// serde's message, minus its position suffix, with an unknown step type
/// spelled out ("\"condition\" isn't a step type. Use one of: ...").
fn plain_parse_error(message: &str) -> String {
    let message = match message.rfind(" at line ") {
        Some(at) if message[at..].contains(" column ") => &message[..at],
        _ => message,
    };
    if let Some(rest) = message.strip_prefix("unknown variant `") {
        if let Some((name, expected)) = rest.split_once("`, expected ") {
            let list = expected
                .strip_prefix("one of ")
                .unwrap_or(expected)
                .replace('`', "");
            return format!("\"{name}\" isn't a step type. Use one of: {list}");
        }
    }
    message.to_string()
}

const DEFINITION_KEYS: &[&str] = &["inputs", "model", "steps"];
const MODEL_KEYS: &[&str] = &["provider", "model"];
const INPUT_KEYS: &[&str] = &["id", "label", "default"];
const STEP_KEYS: &[&str] = &["id", "type", "onError", "retries"];

/// The settings a step of this type reads, besides [`STEP_KEYS`].
fn action_keys(step_type: &str) -> &'static [&'static str] {
    match step_type {
        "fetch_page" => &["urls"],
        "web_search" => &["query", "maxResults"],
        "summarize" => &["prompt", "input", "schema", "model"],
        "template" => &["template"],
        "for_each" => &["items", "steps"],
        "save_artifact" => &["title", "content", "format", "mode"],
        "agent" => &["prompt", "input", "tools", "model"],
        "ask" => &["question", "choices", "default"],
        "notify" => &["title", "body"],
        _ => &[],
    }
}

/// Settings in a raw definition that nothing reads (a wrong-case `on_error`, a
/// misspelt key), in plain English. Loading ignores them so stored workflows
/// still run; saving reports them, since the user meant something by each.
pub fn unknown_settings(raw: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    let Some(def) = raw.as_object() else {
        return problems;
    };
    for key in def.keys() {
        if !DEFINITION_KEYS.contains(&key.as_str()) {
            problems.push(format!(
                "Unknown setting \"{key}\" in the workflow{}",
                suggestion(key, DEFINITION_KEYS)
            ));
        }
    }
    for input in def
        .get("inputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(input) = input.as_object() else {
            continue;
        };
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("(unnamed)");
        for key in input.keys() {
            if !INPUT_KEYS.contains(&key.as_str()) {
                problems.push(format!(
                    "Input \"{id}\": unknown setting \"{key}\"{}",
                    suggestion(key, INPUT_KEYS)
                ));
            }
        }
    }
    unknown_model_settings(def.get("model"), "the workflow's model", &mut problems);
    unknown_step_settings(def.get("steps"), &mut problems);
    problems
}

fn unknown_model_settings(model: Option<&Value>, whose: &str, problems: &mut Vec<String>) {
    let Some(model) = model.and_then(Value::as_object) else {
        return;
    };
    for key in model.keys() {
        if !MODEL_KEYS.contains(&key.as_str()) {
            problems.push(format!(
                "Unknown setting \"{key}\" in {whose}{}",
                suggestion(key, MODEL_KEYS)
            ));
        }
    }
}

fn unknown_step_settings(steps: Option<&Value>, problems: &mut Vec<String>) {
    for step in steps.and_then(Value::as_array).into_iter().flatten() {
        let Some(step) = step.as_object() else {
            continue;
        };
        let id = step
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or("(unnamed)");
        let kind = step.get("type").and_then(Value::as_str).unwrap_or_default();
        let own = action_keys(kind);
        for key in step.keys() {
            if !STEP_KEYS.contains(&key.as_str()) && !own.contains(&key.as_str()) {
                let known: Vec<&str> = STEP_KEYS.iter().chain(own).copied().collect();
                problems.push(format!(
                    "Step \"{id}\": unknown setting \"{key}\"{}",
                    suggestion(key, &known)
                ));
            }
        }
        unknown_model_settings(
            step.get("model"),
            &format!("step \"{id}\"'s model"),
            problems,
        );
        unknown_step_settings(step.get("steps"), problems);
    }
}

/// ` — did you mean "onError"?` when `key` is a known one in another spelling
/// (case, `_` or `-`), else just a full stop.
fn suggestion(key: &str, known: &[&str]) -> String {
    let squash = |s: &str| {
        s.chars()
            .filter(|c| *c != '_' && *c != '-')
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let wanted = squash(key);
    match known.iter().find(|k| squash(k) == wanted) {
        Some(k) => format!(" \u{2014} did you mean \"{k}\"?"),
        None => ".".to_string(),
    }
}

/// Every problem with `def`, in plain English, or `Ok` when it can run.
pub fn validate(def: &WorkflowDefinition) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    if def.steps.is_empty() {
        problems.push("A workflow needs at least one step.".to_string());
    }
    if let Some(model) = &def.model {
        check_model(model, "The workflow's model", &mut problems);
    }
    let mut input_ids = HashSet::new();
    for input in &def.inputs {
        if !is_id(&input.id) {
            problems.push(format!(
                "Input id \"{}\" should use lowercase letters, digits and _.",
                input.id
            ));
        }
        if !input_ids.insert(input.id.as_str()) {
            problems.push(format!("Two inputs are called \"{}\".", input.id));
        }
    }
    let mut all_ids = HashSet::new();
    let mut count = 0;
    let scope = Scope {
        inputs: &input_ids,
        steps: Vec::new(),
        in_loop: false,
    };
    check_steps(&def.steps, scope, &mut all_ids, &mut count, &mut problems);
    if count > MAX_STEPS {
        problems.push(format!(
            "A workflow can have at most {MAX_STEPS} steps; this one has {count}."
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// What a step may read: inputs, the steps before it (in its own and enclosing
/// lists), and inside a `for_each`, `item` and `index`.
#[derive(Clone)]
struct Scope<'a> {
    inputs: &'a HashSet<&'a str>,
    steps: Vec<String>,
    in_loop: bool,
}

fn check_steps(
    steps: &[Step],
    mut scope: Scope<'_>,
    all_ids: &mut HashSet<String>,
    count: &mut usize,
    problems: &mut Vec<String>,
) {
    for step in steps {
        *count += 1;
        let name = if step.id.is_empty() {
            "(unnamed)"
        } else {
            step.id.as_str()
        };
        if !is_id(&step.id) {
            problems.push(format!(
                "Step id \"{}\" should use lowercase letters, digits and _.",
                step.id
            ));
        }
        if !all_ids.insert(step.id.clone()) {
            problems.push(format!("Two steps are called \"{}\".", step.id));
        }
        if step.retries.is_some_and(|r| r > MAX_RETRIES) {
            problems.push(format!(
                "Step \"{name}\" retries too often; the limit is {MAX_RETRIES}."
            ));
        }
        if let Some(model) = &step.model {
            if !matches!(
                step.action,
                StepAction::Summarize { .. } | StepAction::Agent { .. }
            ) {
                problems.push(format!(
                    "Step \"{name}\" can't choose a model: only summarize and agent steps use one."
                ));
            }
            check_model(model, &format!("Step \"{name}\"'s model"), problems);
        }
        let mut texts: Vec<&str> = Vec::new();
        match &step.action {
            StepAction::FetchPage { urls } => {
                if urls.is_empty() {
                    problems.push(format!("Step \"{name}\" has no pages to fetch."));
                }
                if urls.len() > MAX_URLS_PER_FETCH {
                    problems.push(format!(
                        "Step \"{name}\" fetches {} pages; the limit is {MAX_URLS_PER_FETCH}.",
                        urls.len()
                    ));
                }
                texts.extend(urls.iter().map(String::as_str));
            }
            StepAction::WebSearch { query, .. } => texts.push(query),
            StepAction::Summarize {
                prompt,
                input,
                schema,
            } => {
                if prompt.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs an instruction."));
                }
                if matches!(schema, Some(s) if !s.is_object()) {
                    problems.push(format!(
                        "Step \"{name}\": the schema must be a JSON object."
                    ));
                }
                texts.push(prompt);
                texts.push(input);
            }
            StepAction::Template { template } => texts.push(template),
            StepAction::SaveArtifact { title, content, .. } => {
                if title.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a title for the artifact."));
                }
                texts.push(title);
                texts.push(content);
            }
            StepAction::Agent {
                prompt,
                input,
                tools,
            } => {
                if prompt.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs an instruction."));
                }
                for tool in tools {
                    if !AGENT_TOOLS.contains(&tool.as_str()) {
                        problems.push(format!("Step \"{name}\" can't use the tool \"{tool}\"."));
                    }
                }
                let mut seen = HashSet::new();
                if !tools.iter().all(|t| seen.insert(t)) {
                    problems.push(format!("Step \"{name}\" lists a tool twice."));
                }
                texts.push(prompt);
                texts.push(input);
            }
            StepAction::Ask {
                question,
                choices,
                default,
            } => {
                if question.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a question."));
                }
                if choices.len() > MAX_CHOICES {
                    problems.push(format!(
                        "Step \"{name}\" offers {} choices; the limit is {MAX_CHOICES}.",
                        choices.len()
                    ));
                }
                if choices
                    .iter()
                    .any(|c| c.trim().is_empty() || c.chars().count() > MAX_CHOICE_CHARS)
                {
                    problems.push(format!(
                        "Step \"{name}\": each choice needs text, under {MAX_CHOICE_CHARS} characters."
                    ));
                }
                if let Some(default) = default {
                    if !choices.is_empty() && !choices.iter().any(|c| c == default) {
                        problems.push(format!(
                            "Step \"{name}\": the answer taken when nobody answers must be one of the choices."
                        ));
                    }
                }
                texts.push(question);
            }
            StepAction::Notify { title, body } => {
                if title.trim().is_empty() {
                    problems.push(format!(
                        "Step \"{name}\" needs a title for the notification."
                    ));
                }
                texts.push(title);
                texts.push(body);
            }
            StepAction::ForEach { items, steps: body } => {
                check_path(items, &scope, name, problems);
                if body.is_empty() {
                    problems.push(format!("Step \"{name}\" repeats nothing."));
                }
                let inner = Scope {
                    in_loop: true,
                    ..scope.clone()
                };
                check_steps(body, inner, all_ids, count, problems);
            }
        }
        for text in texts {
            match template::references(text) {
                Ok(paths) => {
                    for path in paths {
                        check_path(&path, &scope, name, problems);
                    }
                }
                Err(e) => problems.push(format!("Step \"{name}\": {e}")),
            }
        }
        scope.steps.push(step.id.clone());
    }
}

fn check_model(model: &ModelChoice, whose: &str, problems: &mut Vec<String>) {
    if model.provider.trim().is_empty() || model.model.trim().is_empty() {
        problems.push(format!("{whose} needs both a provider and a model."));
    }
}

fn check_path(path: &str, scope: &Scope<'_>, step: &str, problems: &mut Vec<String>) {
    let mut parts = path.split('.');
    let root = parts.next().unwrap_or_default();
    let ok = match root {
        "inputs" => parts.next().is_some_and(|id| scope.inputs.contains(id)),
        "steps" => parts
            .next()
            .is_some_and(|id| scope.steps.iter().any(|s| s == id)),
        "run" => true,
        "item" | "index" => scope.in_loop,
        _ => false,
    };
    if !ok {
        problems.push(format!(
            "Step \"{step}\" reads {path}, which doesn't exist at that point."
        ));
    }
}

fn is_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn briefing() -> Value {
        json!({
            "inputs": [{ "id": "topic", "label": "Topic", "default": "tech" }],
            "steps": [
                { "id": "fetch", "type": "fetch_page", "urls": ["https://example.com/a", "https://example.com/b"] },
                { "id": "each_page", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                    { "id": "sum", "type": "summarize", "prompt": "Summarize {{inputs.topic}} news",
                      "input": "{{item.text}}" }
                ]},
                { "id": "doc", "type": "template",
                  "template": "{{#each steps.each_page.items}}- {{item.sum.text}}\n{{/each}}" },
                { "id": "save", "type": "save_artifact", "title": "Briefing", "content": "{{steps.doc.text}}" }
            ]
        })
    }

    fn def(v: Value) -> WorkflowDefinition {
        serde_json::from_value(v).expect("parses")
    }

    #[test]
    fn a_valid_briefing_parses_and_validates() {
        let d = def(briefing());
        assert_eq!(d.steps.len(), 4);
        assert!(matches!(
            d.steps[3].action,
            StepAction::SaveArtifact {
                mode: SaveMode::Update,
                format: ArtifactFormat::Markdown,
                ..
            }
        ));
        assert_eq!(validate(&d), Ok(()));
        // Round-trips through the stored form.
        let json = serde_json::to_string(&d).unwrap();
        assert_eq!(parse(&json).unwrap(), d);
    }

    #[test]
    fn reading_a_later_or_unknown_step_is_reported() {
        let d = def(json!({ "steps": [
            { "id": "a", "type": "template", "template": "{{steps.b.text}}" },
            { "id": "b", "type": "template", "template": "{{steps.nope.text}} {{inputs.x}}" }
        ]}));
        let problems = validate(&d).unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("reads steps.b.text")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("reads steps.nope.text")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("reads inputs.x")),
            "{problems:?}"
        );
    }

    #[test]
    fn item_is_only_readable_inside_a_loop() {
        let d = def(json!({ "steps": [
            { "id": "a", "type": "template", "template": "{{item.text}}" }
        ]}));
        assert!(validate(&d)
            .unwrap_err()
            .iter()
            .any(|p| p.contains("reads item.text")));
    }

    #[test]
    fn a_loop_body_sees_steps_before_the_loop_and_earlier_body_steps() {
        let d = def(json!({ "steps": [
            { "id": "list", "type": "template", "template": "x" },
            { "id": "loop", "type": "for_each", "items": "steps.list.text", "steps": [
                { "id": "one", "type": "template", "template": "{{steps.list.text}} {{index}}" },
                { "id": "two", "type": "template", "template": "{{steps.one.text}}" }
            ]}
        ]}));
        assert_eq!(validate(&d), Ok(()));
    }

    #[test]
    fn ids_limits_and_empty_fields_are_checked() {
        let urls: Vec<String> = (0..=MAX_URLS_PER_FETCH)
            .map(|i| format!("https://e.com/{i}"))
            .collect();
        let d = def(json!({ "steps": [
            { "id": "Bad-Id", "type": "fetch_page", "urls": urls },
            { "id": "dup", "type": "template", "template": "x" },
            { "id": "dup", "type": "summarize", "prompt": " ", "input": "x", "schema": [1] },
            { "id": "s", "type": "save_artifact", "title": "", "content": "x" }
        ]}));
        let problems = validate(&d).unwrap_err().join("\n");
        for expected in [
            "Bad-Id",
            "the limit is",
            "Two steps are called \"dup\"",
            "needs an instruction",
            "must be a JSON object",
            "needs a title",
        ] {
            assert!(
                problems.contains(expected),
                "missing {expected:?} in:\n{problems}"
            );
        }
        assert!(validate(&def(json!({ "steps": [] }))).is_err());
    }

    #[test]
    fn retries_have_defaults_and_a_limit_and_notify_needs_a_title() {
        let d = def(json!({ "steps": [
            { "id": "a", "type": "fetch_page", "urls": ["https://x.com"], "retries": 6 },
            { "id": "n", "type": "notify", "title": " ", "body": "{{steps.a.text}}" },
        ]}));
        let problems = validate(&d).unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("retries too often")),
            "{problems:?}"
        );
        assert!(
            problems
                .iter()
                .any(|p| p.contains("needs a title for the notification")),
            "{problems:?}"
        );
        assert_eq!(d.steps[0].retries, Some(6));
        assert_eq!(d.steps[1].retries, None);
        assert_eq!(d.steps[0].action.default_retries(), 2);
        assert_eq!(d.steps[1].action.default_retries(), 0);
        let round_trip = serde_json::to_value(&d.steps[1]).unwrap();
        assert!(
            round_trip.get("retries").is_none(),
            "an unset retries isn't written back"
        );
    }

    #[test]
    fn an_ask_step_needs_a_question_and_a_default_among_its_choices() {
        let d = def(json!({ "steps": [
            { "id": "a", "type": "ask", "question": " ", "choices": ["Yes", ""], "default": "Maybe" },
        ]}));
        let problems = validate(&d).unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("needs a question")),
            "{problems:?}"
        );
        assert!(
            problems
                .iter()
                .any(|p| p.contains("each choice needs text")),
            "{problems:?}"
        );
        assert!(
            problems
                .iter()
                .any(|p| p.contains("must be one of the choices")),
            "{problems:?}"
        );
        let typed = def(json!({ "steps": [
            { "id": "a", "type": "ask", "question": "Anything to add?", "default": "No" },
        ]}));
        assert!(
            validate(&typed).is_ok(),
            "a typed answer may default to anything"
        );
    }

    #[test]
    fn an_agent_step_may_only_use_the_read_only_tools_once_each() {
        let d = def(json!({ "steps": [
            { "id": "a", "type": "agent", "prompt": "Go", "tools": ["web_search", "workspace_write", "web_search"] },
        ]}));
        let problems = validate(&d).unwrap_err();
        assert!(
            problems
                .iter()
                .any(|p| p.contains("can't use the tool \"workspace_write\"")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("lists a tool twice")),
            "{problems:?}"
        );
        let fine = def(json!({ "steps": [
            { "id": "a", "type": "agent", "prompt": "Go", "tools": ["web_fetch", "calculator"] },
        ]}));
        assert!(validate(&fine).is_ok());
    }

    #[test]
    fn unknown_settings_are_named_with_a_suggestion() {
        let raw = json!({
            "inputs": [{ "id": "q", "label": "Q", "defualt": "x" }],
            "steps": [
                { "id": "fetch", "type": "fetch_page", "urls": ["https://a.test"], "on_error": "skip" },
                { "id": "find", "type": "web_search", "query": "x", "max_results": 3 },
                { "id": "each", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                    { "id": "sum", "type": "summarize", "prompt": "p", "input": "i", "Retries": 1, "colour": 1 }
                ]}
            ],
            "name": "x"
        });
        assert_eq!(
            unknown_settings(&raw),
            vec![
                "Unknown setting \"name\" in the workflow.".to_string(),
                "Input \"q\": unknown setting \"defualt\".".to_string(),
                "Step \"fetch\": unknown setting \"on_error\" \u{2014} did you mean \"onError\"?".to_string(),
                "Step \"find\": unknown setting \"max_results\" \u{2014} did you mean \"maxResults\"?".to_string(),
                "Step \"sum\": unknown setting \"Retries\" \u{2014} did you mean \"retries\"?".to_string(),
                "Step \"sum\": unknown setting \"colour\".".to_string(),
            ]
        );
        assert!(unknown_settings(&briefing()).is_empty());
        // Loading stays lenient.
        assert!(parse(
            r#"{"steps":[{"id":"a","type":"template","template":"x","on_error":"skip"}]}"#
        )
        .is_ok());
    }

    #[test]
    fn an_unknown_step_type_is_explained_in_plain_text() {
        let err = parse(r#"{"steps":[{"id":"a","type":"condition"}]}"#).unwrap_err();
        assert!(
            err.starts_with(
                "The workflow definition can't be read: \"condition\" isn't a step type. Use one of: fetch_page, web_search,"
            ),
            "{err}"
        );
        assert!(!err.contains('`') && !err.contains("line 1"), "{err}");
    }

    #[test]
    fn an_unknown_step_type_does_not_parse() {
        assert!(parse(r#"{"steps":[{"id":"a","type":"launch_rockets"}]}"#).is_err());
    }

    fn with_models() -> Value {
        json!({
            "model": { "provider": "openrouter", "model": "z-ai/glm" },
            "steps": [
                { "id": "sum", "type": "summarize", "prompt": "P", "input": "x",
                  "model": { "provider": "openrouter", "model": "deepseek" } },
                { "id": "ag", "type": "agent", "prompt": "P",
                  "model": { "provider": "ollama", "model": "llama" } },
            ]
        })
    }

    #[test]
    fn a_workflow_and_its_llm_steps_may_choose_a_model() {
        let raw = with_models();
        assert!(unknown_settings(&raw).is_empty());
        let d = def(raw);
        assert_eq!(validate(&d), Ok(()));
        assert_eq!(d.model.as_ref().unwrap().model, "z-ai/glm");
        assert_eq!(d.steps[1].model.as_ref().unwrap().provider, "ollama");
        // Round-trips, and a definition without models stores none.
        assert_eq!(parse(&serde_json::to_string(&d).unwrap()).unwrap(), d);
        let plain = serde_json::to_value(def(briefing())).unwrap();
        assert!(plain.get("model").is_none());
        assert!(plain["steps"][0].get("model").is_none());
    }

    #[test]
    fn a_model_on_a_step_that_calls_no_model_is_rejected() {
        let raw = json!({ "steps": [
            { "id": "t", "type": "template", "template": "x",
              "model": { "provider": "ollama", "model": "m" } },
        ]});
        let problems = validate(&def(raw.clone())).unwrap_err();
        assert_eq!(
            problems,
            vec!["Step \"t\" can't choose a model: only summarize and agent steps use one."]
        );
        // And the editor's unknown-setting check names it too.
        assert_eq!(
            unknown_settings(&raw),
            vec!["Step \"t\": unknown setting \"model\".".to_string()]
        );
    }

    #[test]
    fn a_model_needs_both_a_provider_and_a_model() {
        let mut raw = with_models();
        raw["model"]["model"] = json!("  ");
        raw["steps"][0]["model"]["provider"] = json!("");
        let problems = validate(&def(raw)).unwrap_err();
        assert_eq!(
            problems,
            vec![
                "The workflow's model needs both a provider and a model.",
                "Step \"sum\"'s model needs both a provider and a model.",
            ]
        );
        // A half-written model doesn't load at all.
        assert!(parse(r#"{"model":{"provider":"x"},"steps":[]}"#).is_err());
    }

    #[test]
    fn a_misspelt_model_setting_is_reported() {
        let mut raw = with_models();
        raw["model"]["Provider"] = json!("x");
        assert_eq!(
            unknown_settings(&raw),
            vec!["Unknown setting \"Provider\" in the workflow's model \u{2014} did you mean \"provider\"?"
                .to_string()]
        );
    }
}
