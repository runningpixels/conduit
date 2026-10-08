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
    /// An absolute folder the workflow's `read_file` steps may read from, and
    /// nothing outside it. Its existence is checked when a step runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
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
/// - `fetch_page`: `pages` (each `url, title, text, links, lookedEmpty, error,
///   contentType`) and `text` (all readable pages joined under their titles);
///   a CSV, JSON or plain-text response is kept as it came, not read as an article
/// - `read_file`: `path`, `name`, `text`, `modified` and `bytes`
/// - `parse_data`: a table (`columns`, `rows`, `count`, `text`, `warnings`), or
///   for JSON that isn't a list of objects, `data` and `text`
/// - `web_search`: `results` (the search backend's result objects)
/// - `summarize`: `text`, plus `data` (the parsed JSON) when `schema` is set
/// - `template`: `text`
/// - `for_each`: `items`, one object per element holding that iteration's step
///   outputs by step id
/// - `save_artifact`: `artifactId`
/// - `notify`: `delivered` (or `sent`, `unchanged` and `hash` with `onlyIfChanged`)
/// - `condition`: `passed`, `is`, `hash`, `previousHash`, `changed` and `text`
///   (why it passed or stopped the run)
/// - `ask`: `answer`
/// - `agent`: `text` (its answer) and `toolCalls` (the tools it called)
/// - `edit_deck`: `deckId`, `title`, `changed` (slide ids), `skippedPinned`,
///   `reply` (the model's one sentence), `layoutChecked` (always false: the
///   layout is checked when the deck is next opened) and `model`
/// - `edit_draft`: `draftId`, `title`, `changed` (block ids), `skippedPinned`,
///   `reply` and `model`
/// - `research`: `reportArtifactId`, `title`, `text` (the report, Markdown),
///   `summary`, `sources` (each `title, url, credibility`), `unanswered`,
///   `verifiedQuotes`, `droppedClaims` and `model`
/// - `search_documents`: `passages` (each `document, collection, text,
///   citation`), `count` and `text` (the passages numbered, with their
///   document names)
/// - `connector_tool`: `text` (the tool's text, capped like other model
///   text), `data` (its structured content, else its text parsed when that
///   is a JSON object or list, else null), `isError` (always false: a tool
///   that reports an error fails the step), `connector` (`id, name`) and
///   `tool`
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
        /// Skip the save when the content is the same as the last run's.
        #[serde(default, skip_serializing_if = "is_false")]
        only_if_changed: bool,
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
        /// Skip the notification when it reads the same as the last run's.
        #[serde(default, skip_serializing_if = "is_false")]
        only_if_changed: bool,
    },
    /// Carry on only if a test on `value` passes; otherwise the run ends,
    /// completed, as "nothing new". Top-level steps only.
    /// Read a file from the workflow's folder (text, CSV, JSON, PDF or DOCX).
    ReadFile {
        /// A template: the file's path inside the folder.
        path: String,
    },
    /// Turn CSV, TSV or JSON text into rows.
    ParseData {
        /// The text to read, usually a reference to an earlier step.
        input: String,
        /// One of [`DATA_FORMATS`]. Kept as text so a wrong one is reported
        /// in plain words by [`validate`].
        format: String,
    },
    /// Update a saved deck with an agent turn in the deck's own chat: change
    /// what `instructions` ask for, keep the user's pinned text. Top-level
    /// steps only.
    EditDeck {
        /// The deck's id.
        deck: String,
        /// What to change ("Update slide 3's chart with these numbers"); a template.
        instructions: String,
        /// The data the instructions work on, usually an earlier step's
        /// output; a template. When set but empty, the step fails without
        /// asking a model.
        #[serde(default)]
        input: Option<String>,
    },
    /// Update a saved draft the same way. A section that isn't in the draft
    /// yet is added at the end. Top-level steps only.
    EditDraft {
        /// The draft's id.
        draft: String,
        instructions: String,
        #[serde(default)]
        input: Option<String>,
    },
    /// Research a question on the web and write a cited report: the same
    /// search, read, quote-check and write run as in chat, with the brief
    /// drafted automatically (it is not shown for approval). Top-level steps
    /// only.
    Research {
        /// What to find out; a template. When it comes out empty, the step
        /// fails without asking a model.
        question: String,
        /// One of [`RESEARCH_DEPTHS`]. Kept as text so a wrong one is
        /// reported in plain words by [`validate`].
        #[serde(default = "standard_depth")]
        depth: String,
    },
    /// Find passages in the user's saved Documents collections.
    SearchDocuments {
        /// The collections' ids (chosen by the user, never invented).
        collections: Vec<String>,
        /// What to look for; a template. When it comes out empty, the step
        /// fails.
        query: String,
        /// How many passages to keep, 1 to [`MAX_TOP_K`]; [`DEFAULT_TOP_K`]
        /// when not set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        top_k: Option<u32>,
    },
    /// Call a tool that only reads, on a connector the user installed.
    ConnectorTool {
        /// The connector's id (chosen by the user, never invented).
        connector: String,
        /// The tool's name, as the connector reports it.
        tool: String,
        /// The tool's arguments, an object. Every string anywhere inside is a
        /// template; other values pass through.
        #[serde(default = "empty_object")]
        arguments: Value,
    },
    Condition {
        /// A template: the text to test.
        value: String,
        /// One of [`CONDITION_TESTS`]. Kept as text so a wrong one is reported
        /// in plain words by [`validate`] rather than as a parse error.
        #[serde(default)]
        is: String,
        /// What `contains`, `not_contains` and `equals` compare with (a
        /// template); not allowed with the other tests.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The tests a `condition` step offers.
pub const CONDITION_TESTS: &[&str] = &[
    "changed",
    "not_empty",
    "empty",
    "contains",
    "not_contains",
    "equals",
];

/// The formats a `parse_data` step reads.
pub const DATA_FORMATS: &[&str] = &["csv", "tsv", "json"];

/// The depths a `research` step offers (a workflow never runs a deep survey:
/// it is long and costly).
pub const RESEARCH_DEPTHS: &[&str] = &["quick", "standard"];

/// Most passages a `search_documents` step may keep, and how many it keeps
/// when not told.
pub const MAX_TOP_K: u32 = 20;
pub const DEFAULT_TOP_K: u32 = 6;

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// Every string in `value`, at any depth: the templates of a connector
/// step's arguments.
pub fn strings_in(value: &Value) -> Vec<&str> {
    fn walk<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
        match value {
            Value::String(s) => out.push(s),
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            Value::Object(fields) => fields.values().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

fn standard_depth() -> String {
    "standard".to_string()
}

/// Whether a condition test compares with `text`.
pub fn condition_needs_text(is: &str) -> bool {
    matches!(is, "contains" | "not_contains" | "equals")
}

impl StepAction {
    /// Retries when the step doesn't say: a network step twice (sites and
    /// search backends fail for a moment), a model call once, nothing else.
    pub fn default_retries(&self) -> u32 {
        match self {
            StepAction::FetchPage { .. } | StepAction::WebSearch { .. } => 2,
            StepAction::Summarize { .. } => 1,
            // Only a conversation that is busy is tried again; a model that
            // already changed the document is never asked twice.
            StepAction::EditDeck { .. } | StepAction::EditDraft { .. } => 1,
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
    if let Some(rest) = message.strip_prefix("missing field `") {
        if let Some(name) = rest.strip_suffix('`') {
            return format!("A step is missing its \"{name}\" setting.");
        }
    }
    if let Some(rest) = message.strip_prefix("invalid type: ") {
        if let Some((found, expected)) = rest.split_once(", expected ") {
            let expected = match expected {
                "a boolean" => "true or false",
                "a string" => "text in quotes",
                "a sequence" => "a list in [ ]",
                other => other,
            };
            return format!("A setting has {found} where it needs {expected}.");
        }
    }
    message.to_string()
}

const DEFINITION_KEYS: &[&str] = &["inputs", "model", "folder", "steps"];
const MODEL_KEYS: &[&str] = &["provider", "model"];
const INPUT_KEYS: &[&str] = &["id", "label", "default"];
const STEP_KEYS: &[&str] = &["id", "type", "onError", "retries"];

/// Every step type, as written in a definition's `"type"` (read from the
/// enum's own error message, so a new variant appears here by itself).
pub fn step_types() -> Vec<String> {
    let error = serde_json::from_value::<StepAction>(serde_json::json!({ "type": "?" }))
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    error
        .split_once("expected one of ")
        .map(|(_, list)| {
            list.split(", ")
                .map(|name| name.trim().trim_matches('`').to_string())
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Parse and check a raw definition as saving does: unreadable, unknown
/// settings and every [`validate`] problem, joined one per line.
pub fn check_value(definition: &Value) -> Result<(), String> {
    let parsed: WorkflowDefinition =
        serde_json::from_value(definition.clone()).map_err(|e| unreadable(&e))?;
    // Loading ignores settings it doesn't know; saving does not.
    let mut problems = unknown_settings(definition);
    if let Err(more) = validate(&parsed) {
        problems.extend(more);
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join(
            "
",
        ))
    }
}

/// The settings a step of this type reads, besides [`STEP_KEYS`].
pub fn action_keys(step_type: &str) -> &'static [&'static str] {
    match step_type {
        "fetch_page" => &["urls"],
        "web_search" => &["query", "maxResults"],
        "summarize" => &["prompt", "input", "schema", "model"],
        "template" => &["template"],
        "for_each" => &["items", "steps"],
        "save_artifact" => &["title", "content", "format", "mode", "onlyIfChanged"],
        "agent" => &["prompt", "input", "tools", "model"],
        "ask" => &["question", "choices", "default"],
        "notify" => &["title", "body", "onlyIfChanged"],
        "condition" => &["value", "is", "text"],
        "read_file" => &["path"],
        "parse_data" => &["input", "format"],
        "edit_deck" => &["deck", "instructions", "input", "model"],
        "edit_draft" => &["draft", "instructions", "input", "model"],
        "research" => &["question", "depth", "model"],
        "search_documents" => &["collections", "query", "topK"],
        // `arguments` is the tool's own: its keys are free-form.
        "connector_tool" => &["connector", "tool", "arguments"],
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
    let folder = def
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty());
    if folder.is_some_and(|f| !std::path::Path::new(f).is_absolute()) {
        problems.push(
            "The workflow's folder needs a full path, starting from the top of a drive."
                .to_string(),
        );
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
        has_folder: folder.is_some(),
        loops: Vec::new(),
        own: Vec::new(),
        item_is_loop_result: false,
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
    /// The workflow has a folder to read files from.
    has_folder: bool,
    /// The `for_each` steps before this one: its id and its own steps (id and
    /// a text-like output to suggest), which is all a result item holds.
    loops: Vec<LoopShape>,
    /// The ids of the steps in the innermost loop being checked, and whether
    /// its `item` comes from an earlier loop's results (whose items are
    /// keyed by step id, so `item.<id>` is right there).
    own: Vec<String>,
    item_is_loop_result: bool,
}

/// What one round of an earlier `for_each` leaves behind.
#[derive(Clone)]
struct LoopShape {
    id: String,
    steps: Vec<(String, Option<&'static str>)>,
}

/// The output of a step worth suggesting as `item.<id>.<field>`.
fn text_field(action: &StepAction) -> Option<&'static str> {
    match action {
        StepAction::Summarize { .. }
        | StepAction::Template { .. }
        | StepAction::Agent { .. }
        | StepAction::FetchPage { .. }
        | StepAction::ReadFile { .. }
        | StepAction::ConnectorTool { .. }
        | StepAction::ParseData { .. } => Some("text"),
        StepAction::Ask { .. } => Some("answer"),
        _ => None,
    }
}

/// Fields a loop's own elements commonly have (a page, a search result), so
/// `item.<field>` is not mistaken for a step of the loop with the same id.
const ITEM_FIELDS: &[&str] = &[
    "url",
    "title",
    "text",
    "links",
    "snippet",
    "error",
    "lookedEmpty",
    "contentType",
];

fn check_item_reads(
    paths: &[String],
    texts_each: &[(String, Vec<String>)],
    scope: &Scope<'_>,
    name: &str,
    problems: &mut Vec<String>,
) {
    // Inside a loop body: `item.<own earlier step>` is the wrong address.
    if scope.in_loop && !scope.item_is_loop_result {
        for path in paths {
            let mut parts = path.splitn(3, '.');
            if parts.next() != Some("item") {
                continue;
            }
            let Some(id) = parts.next() else { continue };
            if scope.own.iter().any(|s| s == id)
                && scope.steps.iter().any(|s| s == id)
                && !ITEM_FIELDS.contains(&id)
            {
                let rest = path.strip_prefix("item.").unwrap_or(path);
                problems.push(format!(
                    "Step \"{name}\" reads {path}, but {id} is a step in this loop \u{2014} use steps.{rest} for its result in the current round."
                ));
            }
        }
    }
    // Inside `{{#each steps.<loop>.items}}`: `item.<x>` must be a loop step.
    for (list, reads) in texts_each {
        let parts: Vec<&str> = list.split('.').collect();
        let [steps, id, items] = parts[..] else {
            continue;
        };
        if steps != "steps" || items != "items" {
            continue;
        }
        let Some(shape) = scope.loops.iter().find(|l| l.id == id) else {
            continue;
        };
        let mut seen = HashSet::new();
        for read in reads {
            let Some(x) = read.split('.').nth(1) else {
                continue;
            };
            if shape.steps.iter().any(|(s, _)| s == x) || !seen.insert(read.as_str()) {
                continue;
            }
            let held = shape
                .steps
                .iter()
                .map(|(s, _)| format!("item.{s}"))
                .collect::<Vec<_>>()
                .join(", ");
            let example = shape
                .steps
                .iter()
                .rev()
                .find(|(_, f)| f.is_some())
                .or(shape.steps.last())
                .map(|(s, f)| match f {
                    Some(f) => format!("item.{s}.{f}"),
                    None => format!("item.{s}"),
                })
                .unwrap_or_default();
            problems.push(format!(
                "Step \"{name}\" reads {read} inside a loop over {list}, but each item only holds what the loop's steps made ({held}). Use one of those, e.g. {example}."
            ));
        }
    }
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
                StepAction::Summarize { .. }
                    | StepAction::Agent { .. }
                    | StepAction::EditDeck { .. }
                    | StepAction::EditDraft { .. }
                    | StepAction::Research { .. }
            ) {
                problems.push(format!(
                    "Step \"{name}\" can't choose a model: only summarize, agent, edit_deck, edit_draft and research steps use one."
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
            StepAction::SaveArtifact {
                title,
                content,
                only_if_changed,
                ..
            } => {
                if title.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a title for the artifact."));
                }
                if *only_if_changed && scope.in_loop {
                    problems.push(only_if_changed_in_loop(name));
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
            StepAction::Notify {
                title,
                body,
                only_if_changed,
            } => {
                if title.trim().is_empty() {
                    problems.push(format!(
                        "Step \"{name}\" needs a title for the notification."
                    ));
                }
                if *only_if_changed && scope.in_loop {
                    problems.push(only_if_changed_in_loop(name));
                }
                texts.push(title);
                texts.push(body);
            }
            StepAction::ReadFile { path } => {
                if !scope.has_folder {
                    problems.push(format!(
                        "Step \"{name}\" reads a file, so choose the workflow's folder first."
                    ));
                }
                if path.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a file path."));
                }
                texts.push(path);
            }
            StepAction::ParseData { input, format } => {
                if format.is_empty() {
                    problems.push(format!(
                        "Step \"{name}\" needs a format (one of: {}).",
                        DATA_FORMATS.join(", ")
                    ));
                } else if !DATA_FORMATS.contains(&format.as_str()) {
                    problems.push(format!(
                        "Step \"{name}\": \"{format}\" isn't a data format. Use one of: {}.",
                        DATA_FORMATS.join(", ")
                    ));
                }
                texts.push(input);
            }
            StepAction::EditDeck {
                deck,
                instructions,
                input,
            } => {
                check_update(
                    ("deck", deck),
                    instructions,
                    input.as_deref(),
                    &scope,
                    name,
                    problems,
                    &mut texts,
                );
            }
            StepAction::EditDraft {
                draft,
                instructions,
                input,
            } => {
                check_update(
                    ("draft", draft),
                    instructions,
                    input.as_deref(),
                    &scope,
                    name,
                    problems,
                    &mut texts,
                );
            }
            StepAction::Research { question, depth } => {
                if scope.in_loop {
                    problems.push(format!(
                        "Step \"{name}\" researches the web, which only works on the steps at the top level, not inside a repeated step."
                    ));
                }
                if question.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a question to research."));
                }
                if !RESEARCH_DEPTHS.contains(&depth.as_str()) {
                    problems.push(format!(
                        "Step \"{name}\": \"{depth}\" isn't a research depth. Use one of: {}.",
                        RESEARCH_DEPTHS.join(", ")
                    ));
                }
                texts.push(question);
            }
            StepAction::SearchDocuments {
                collections,
                query,
                top_k,
            } => {
                if collections.iter().all(|c| c.trim().is_empty()) {
                    problems.push(format!(
                        "Step \"{name}\" needs at least one collection of documents to search."
                    ));
                }
                if query.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs something to search for."));
                }
                if top_k.is_some_and(|k| !(1..=MAX_TOP_K).contains(&k)) {
                    problems.push(format!(
                        "Step \"{name}\" keeps too many or too few passages; choose 1 to {MAX_TOP_K}."
                    ));
                }
                texts.push(query);
            }
            StepAction::ConnectorTool {
                connector,
                tool,
                arguments,
            } => {
                if connector.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a connector to use."));
                }
                if tool.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs a tool to call."));
                }
                if !arguments.is_object() {
                    problems.push(format!(
                        "Step \"{name}\": the tool's arguments should be a set of named values."
                    ));
                }
                texts.extend(strings_in(arguments));
            }
            StepAction::Condition { value, is, text } => {
                if scope.in_loop {
                    problems.push(format!(
                        "Step \"{name}\" is a condition inside a repeated step; conditions only work on the steps at the top level."
                    ));
                }
                if value.trim().is_empty() {
                    problems.push(format!("Step \"{name}\" needs something to check."));
                }
                if is.is_empty() {
                    problems.push(format!(
                        "Step \"{name}\" needs a test (one of: {}).",
                        CONDITION_TESTS.join(", ")
                    ));
                } else if !CONDITION_TESTS.contains(&is.as_str()) {
                    problems.push(format!(
                        "Step \"{name}\": \"{is}\" isn't a test. Use one of: {}.",
                        CONDITION_TESTS.join(", ")
                    ));
                } else if condition_needs_text(is) {
                    if text.as_deref().is_none_or(|t| t.trim().is_empty()) {
                        problems.push(format!(
                            "Step \"{name}\": \"{is}\" needs some text to compare with."
                        ));
                    }
                } else if text.is_some() {
                    problems.push(format!(
                        "Step \"{name}\": \"{is}\" doesn't compare with any text, so remove the text."
                    ));
                }
                texts.push(value);
                if let Some(text) = text {
                    texts.push(text);
                }
            }
            StepAction::ForEach { items, steps: body } => {
                check_path(items, &scope, name, problems);
                if body.is_empty() {
                    problems.push(format!("Step \"{name}\" repeats nothing."));
                }
                let from_loop_result = {
                    let parts: Vec<&str> = items.split('.').collect();
                    matches!(parts[..], ["steps", id, "items"]
                        if scope.loops.iter().any(|l| l.id == id))
                };
                let inner = Scope {
                    in_loop: true,
                    own: body.iter().map(|s| s.id.clone()).collect(),
                    item_is_loop_result: from_loop_result,
                    ..scope.clone()
                };
                check_steps(body, inner, all_ids, count, problems);
            }
        }
        for text in texts {
            match (template::references(text), template::each_item_reads(text)) {
                (Ok(paths), Ok(each_reads)) => {
                    for path in &paths {
                        check_path(path, &scope, name, problems);
                    }
                    check_item_reads(&paths, &each_reads, &scope, name, problems);
                }
                (Err(e), _) | (_, Err(e)) => problems.push(format!("Step \"{name}\": {e}")),
            }
        }
        if let StepAction::ForEach { steps: body, .. } = &step.action {
            scope.loops.push(LoopShape {
                id: step.id.clone(),
                steps: body
                    .iter()
                    .map(|s| (s.id.clone(), text_field(&s.action)))
                    .collect(),
            });
        }
        scope.steps.push(step.id.clone());
    }
}

/// The checks `edit_deck` and `edit_draft` share. `target` is the kind ("deck"
/// or "draft") and the id chosen.
fn check_update<'a>(
    target: (&str, &str),
    instructions: &'a str,
    input: Option<&'a str>,
    scope: &Scope<'_>,
    name: &str,
    problems: &mut Vec<String>,
    texts: &mut Vec<&'a str>,
) {
    let (kind, id) = target;
    if id.trim().is_empty() {
        problems.push(format!("Step \"{name}\" needs a {kind} to update."));
    }
    if instructions.trim().is_empty() {
        problems.push(format!("Step \"{name}\" needs instructions."));
    }
    if scope.in_loop {
        problems.push(format!(
            "Step \"{name}\" updates a saved {kind}, which only works on the steps at the top level, not inside a repeated step."
        ));
    }
    texts.push(instructions);
    if let Some(input) = input {
        texts.push(input);
    }
}

fn only_if_changed_in_loop(name: &str) -> String {
    format!(
        "Step \"{name}\" asks to run only if something changed, which only works on the steps at the top level, not inside a repeated step."
    )
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
    fn a_loop_result_item_only_holds_the_loops_own_steps() {
        let loop_then = |template: &str| {
            json!({ "steps": [
                { "id": "fetch", "type": "fetch_page", "urls": ["https://example.com"] },
                { "id": "each", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                    { "id": "fetch_one", "type": "template", "template": "{{item.url}}" },
                    { "id": "sum", "type": "summarize", "prompt": "p", "input": "{{item.text}}" }
                ]},
                { "id": "doc", "type": "template", "template": template },
            ]})
        };
        assert_eq!(
            problems_of(loop_then("{{#each steps.each.items}}{{item.title}}{{/each}}")),
            vec!["Step \"doc\" reads item.title inside a loop over steps.each.items, but each item only holds what the loop's steps made (item.fetch_one, item.sum). Use one of those, e.g. item.sum.text."]
        );
        // The loop's own steps, and a nested block's own item, are fine.
        let fine = loop_then(
            "{{#each steps.each.items}}{{item.sum.text}}{{item.fetch_one}}{{#each item.sum.data}}{{item.name}}{{/each}}{{/each}}{{item.title}}",
        );
        // `item` outside any block is the existing "only inside a loop" check.
        let problems = problems_of(fine);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("reads item.title, which doesn't exist"));
    }

    #[test]
    fn a_loop_step_reads_its_earlier_steps_by_step_id_not_item() {
        let body = |input: &str| {
            json!({ "steps": [
                { "id": "fetch", "type": "fetch_page", "urls": ["https://example.com"] },
                { "id": "each", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                    { "id": "clean", "type": "template", "template": "{{item.text}}" },
                    { "id": "sum", "type": "summarize", "prompt": "p", "input": input },
                ]},
            ]})
        };
        assert_eq!(
            problems_of(body("{{item.clean.text}}")),
            vec!["Step \"sum\" reads item.clean.text, but clean is a step in this loop \u{2014} use steps.clean.text for its result in the current round."]
        );
        assert_eq!(
            validate(&def(body("{{steps.clean.text}} {{item.title}}"))),
            Ok(())
        );
        // A loop over an earlier loop's results is keyed by step id: item.<id> is right.
        let chained = json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": ["https://example.com"] },
            { "id": "one", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                { "id": "sum", "type": "template", "template": "{{item.text}}" }
            ]},
            { "id": "two", "type": "for_each", "items": "steps.one.items", "steps": [
                { "id": "again", "type": "template", "template": "{{item.sum.text}}" }
            ]},
        ]});
        assert_eq!(validate(&def(chained)), Ok(()));
    }

    #[test]
    fn the_starter_shapes_still_validate() {
        // The morning-briefing starter: heading and summary read the page
        // (item.url/title/text/error), the template reads the loop's results.
        let d = def(json!({
            "inputs": [{ "id": "site_one", "label": "A", "default": "x" }],
            "steps": [
                { "id": "fetch", "type": "fetch_page", "urls": ["{{inputs.site_one}}"] },
                { "id": "each_site", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                    { "id": "heading", "type": "template", "template": "## {{item.url}}\n{{item.error}}" },
                    { "id": "summary", "type": "summarize", "prompt": "p",
                      "input": "{{item.title}}\n\n{{item.text}}", "onError": "skip" }
                ]},
                { "id": "briefing", "type": "template",
                  "template": "{{#each steps.each_site.items}}{{item.heading.text}}{{item.summary.text}}\n\n{{/each}}" },
                { "id": "save", "type": "save_artifact", "title": "t", "content": "{{steps.briefing.text}}" }
            ]
        }));
        assert_eq!(validate(&d), Ok(()));
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
        let err = parse(r#"{"steps":[{"id":"a","type":"launch_rockets"}]}"#).unwrap_err();
        assert!(
            err.starts_with(
                "The workflow definition can't be read: \"launch_rockets\" isn't a step type. Use one of: fetch_page, web_search,"
            ),
            "{err}"
        );
        assert!(!err.contains('`') && !err.contains("line 1"), "{err}");
    }

    #[test]
    fn a_missing_or_mistyped_setting_is_explained_in_plain_text() {
        let err = parse(r#"{"steps":[{"id":"c","type":"condition","is":"changed"}]}"#).unwrap_err();
        assert!(
            err.ends_with("A step is missing its \"value\" setting."),
            "{err}"
        );
        let err = parse(
            r#"{"steps":[{"id":"n","type":"notify","title":"T","body":"B","onlyIfChanged":"yes"}]}"#,
        )
        .unwrap_err();
        assert!(
            err.ends_with("A setting has string \"yes\" where it needs true or false."),
            "{err}"
        );
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
            vec!["Step \"t\" can't choose a model: only summarize, agent, edit_deck, edit_draft and research steps use one."]
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

    fn with_condition(condition: Value) -> Value {
        json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": ["https://example.com"] },
            condition,
        ]})
    }

    fn problems_of(raw: Value) -> Vec<String> {
        validate(&def(raw)).unwrap_err()
    }

    #[test]
    fn conditions_and_only_if_changed_validate() {
        for condition in [
            json!({ "id": "c", "type": "condition", "value": "{{steps.fetch.text}}", "is": "changed" }),
            json!({ "id": "c", "type": "condition", "value": "{{steps.fetch.text}}", "is": "not_empty" }),
            json!({ "id": "c", "type": "condition", "value": "{{steps.fetch.text}}", "is": "empty" }),
            json!({ "id": "c", "type": "condition", "value": "x", "is": "contains", "text": "{{steps.fetch.text}}" }),
            json!({ "id": "c", "type": "condition", "value": "x", "is": "not_contains", "text": "a" }),
            json!({ "id": "c", "type": "condition", "value": "x", "is": "equals", "text": "a" }),
        ] {
            assert_eq!(
                validate(&def(with_condition(condition.clone()))),
                Ok(()),
                "{condition}"
            );
            assert!(unknown_settings(&with_condition(condition)).is_empty());
        }
        let raw = json!({ "steps": [
            { "id": "n", "type": "notify", "title": "t", "onlyIfChanged": true },
            { "id": "s", "type": "save_artifact", "title": "t", "content": "c", "onlyIfChanged": true },
        ]});
        assert_eq!(validate(&def(raw.clone())), Ok(()));
        assert!(unknown_settings(&raw).is_empty());
        // It round-trips, and stays out of the stored JSON when off.
        let stored = serde_json::to_value(def(raw)).unwrap();
        assert_eq!(stored["steps"][0]["onlyIfChanged"], json!(true));
        let off = def(json!({ "steps": [{ "id": "n", "type": "notify", "title": "t" }] }));
        assert!(serde_json::to_value(off).unwrap()["steps"][0]
            .get("onlyIfChanged")
            .is_none());
    }

    #[test]
    fn a_condition_needs_its_text_only_where_it_compares() {
        let problems = problems_of(with_condition(
            json!({ "id": "c", "type": "condition", "value": "x", "is": "contains" }),
        ));
        assert_eq!(
            problems,
            vec!["Step \"c\": \"contains\" needs some text to compare with."]
        );
        let problems = problems_of(with_condition(
            json!({ "id": "c", "type": "condition", "value": "x", "is": "equals", "text": "  " }),
        ));
        assert_eq!(problems.len(), 1);
        let problems = problems_of(with_condition(
            json!({ "id": "c", "type": "condition", "value": "x", "is": "changed", "text": "a" }),
        ));
        assert_eq!(
            problems,
            vec!["Step \"c\": \"changed\" doesn't compare with any text, so remove the text."]
        );
    }

    #[test]
    fn a_condition_needs_a_value_and_a_known_test() {
        let problems = problems_of(with_condition(
            json!({ "id": "c", "type": "condition", "value": "x", "is": "bigger" }),
        ));
        assert_eq!(
            problems,
            vec!["Step \"c\": \"bigger\" isn't a test. Use one of: changed, not_empty, empty, contains, not_contains, equals."]
        );
        let problems = problems_of(with_condition(
            json!({ "id": "c", "type": "condition", "value": "x" }),
        ));
        assert!(
            problems[0].starts_with("Step \"c\" needs a test"),
            "{problems:?}"
        );
        let problems = problems_of(with_condition(
            json!({ "id": "c", "type": "condition", "value": " ", "is": "empty" }),
        ));
        assert_eq!(problems, vec!["Step \"c\" needs something to check."]);
        // The value is a template: a step that doesn't exist yet is caught.
        let problems = problems_of(json!({ "steps": [
            { "id": "c", "type": "condition", "value": "{{steps.later.text}}", "is": "changed" },
            { "id": "later", "type": "template", "template": "x" },
        ]}));
        assert!(problems[0].contains("steps.later.text"), "{problems:?}");
    }

    #[test]
    fn conditions_and_only_if_changed_are_refused_inside_a_for_each() {
        let inside = |step: Value| {
            json!({ "steps": [
                { "id": "fetch", "type": "fetch_page", "urls": ["https://example.com"] },
                { "id": "each", "type": "for_each", "items": "steps.fetch.pages", "steps": [step] },
            ]})
        };
        let problems = problems_of(inside(
            json!({ "id": "c", "type": "condition", "value": "{{item.text}}", "is": "not_empty" }),
        ));
        assert_eq!(
            problems,
            vec!["Step \"c\" is a condition inside a repeated step; conditions only work on the steps at the top level."]
        );
        for step in [
            json!({ "id": "n", "type": "notify", "title": "t", "onlyIfChanged": true }),
            json!({ "id": "s", "type": "save_artifact", "title": "t", "content": "c", "onlyIfChanged": true }),
        ] {
            let problems = problems_of(inside(step));
            assert!(
                problems[0].contains("which only works on the steps at the top level"),
                "{problems:?}"
            );
        }
        // Off, they are fine in a loop.
        let fine = inside(json!({ "id": "n", "type": "notify", "title": "t" }));
        assert_eq!(validate(&def(fine)), Ok(()));
    }

    #[test]
    fn a_condition_setting_misspelt_is_reported() {
        let raw = with_condition(
            json!({ "id": "c", "type": "condition", "value": "x", "is": "empty", "Text": "a" }),
        );
        assert_eq!(
            unknown_settings(&raw),
            vec![
                "Step \"c\": unknown setting \"Text\" \u{2014} did you mean \"text\"?".to_string()
            ]
        );
    }

    fn file_steps() -> Value {
        json!([
            { "id": "f", "type": "read_file", "path": "reports/metrics.csv" },
            { "id": "d", "type": "parse_data", "input": "{{steps.f.text}}", "format": "csv" },
        ])
    }

    fn some_folder() -> &'static str {
        if cfg!(windows) {
            "C:\\data\\reports"
        } else {
            "/data/reports"
        }
    }

    #[test]
    fn a_file_step_needs_the_workflows_folder() {
        let with = json!({ "folder": some_folder(), "steps": file_steps() });
        let d = def(with.clone());
        assert_eq!(d.folder.as_deref(), Some(some_folder()));
        assert!(unknown_settings(&with).is_empty());
        assert_eq!(validate(&d), Ok(()));
        // It round-trips, and a workflow without one stores none.
        assert_eq!(parse(&serde_json::to_string(&d).unwrap()).unwrap(), d);
        assert!(serde_json::to_value(def(briefing()))
            .unwrap()
            .get("folder")
            .is_none());

        let problems = problems_of(json!({ "steps": file_steps() }));
        assert_eq!(
            problems,
            vec!["Step \"f\" reads a file, so choose the workflow's folder first."]
        );
        let blank = problems_of(json!({ "folder": "  ", "steps": file_steps() }));
        assert_eq!(blank, problems);
        let relative = problems_of(json!({ "folder": "reports", "steps": file_steps() }));
        assert_eq!(
            relative,
            vec!["The workflow's folder needs a full path, starting from the top of a drive."]
        );
    }

    #[test]
    fn file_and_data_steps_check_their_settings() {
        let problems = problems_of(json!({ "folder": some_folder(), "steps": [
            { "id": "f", "type": "read_file", "path": " " },
            { "id": "a", "type": "parse_data", "input": "{{steps.f.text}}", "format": "" },
            { "id": "b", "type": "parse_data", "input": "{{steps.later.text}}", "format": "xml" },
            { "id": "later", "type": "template", "template": "x" },
        ]}));
        let has = |text: &str| problems.iter().any(|p| p.contains(text));
        assert!(has("Step \"f\" needs a file path."), "{problems:?}");
        assert!(has("Step \"a\" needs a format"), "{problems:?}");
        assert!(
            has("Step \"b\": \"xml\" isn't a data format. Use one of: csv, tsv, json."),
            "{problems:?}"
        );
        assert!(has("steps.later.text"), "{problems:?}");
        // Misspelt settings are named.
        let raw = json!({ "folder": some_folder(), "steps": [
            { "id": "f", "type": "read_file", "Path": "a.csv" },
            { "id": "d", "type": "parse_data", "input": "x", "format": "csv", "Format": "tsv" },
        ]});
        assert_eq!(
            unknown_settings(&raw),
            vec![
                "Step \"f\": unknown setting \"Path\" \u{2014} did you mean \"path\"?".to_string(),
                "Step \"d\": unknown setting \"Format\" \u{2014} did you mean \"format\"?"
                    .to_string(),
            ]
        );
        // A missing format is a parse error in plain words.
        let err = parse(r#"{"steps":[{"id":"d","type":"parse_data","input":"x"}]}"#).unwrap_err();
        assert!(
            err.ends_with("A step is missing its \"format\" setting."),
            "{err}"
        );
    }

    #[test]
    fn update_steps_need_a_document_and_instructions_and_stay_at_the_top_level() {
        let fine = def(json!({ "steps": [
            { "id": "d", "type": "edit_deck", "deck": "deck-1", "instructions": "Update slide 3",
              "input": "{{inputs.q}}", "model": { "provider": "ollama", "model": "m" } },
            { "id": "w", "type": "edit_draft", "draft": "draft-1", "instructions": "Add a section" },
        ], "inputs": [{ "id": "q", "label": "Q" }]}));
        assert!(validate(&fine).is_ok(), "{:?}", validate(&fine));
        assert_eq!(fine.steps[0].action.default_retries(), 1);
        let StepAction::EditDeck { deck, input, .. } = &fine.steps[0].action else {
            panic!("an edit_deck step");
        };
        assert_eq!(
            (deck.as_str(), input.as_deref()),
            ("deck-1", Some("{{inputs.q}}"))
        );

        let bad = def(json!({ "steps": [
            { "id": "d", "type": "edit_deck", "deck": " ", "instructions": "" },
            { "id": "w", "type": "edit_draft", "draft": "", "instructions": "Go" },
            { "id": "each", "type": "for_each", "items": "steps.d.text", "steps": [
                { "id": "in", "type": "edit_deck", "deck": "x", "instructions": "Go" }
            ]},
        ]}));
        let problems = validate(&bad).unwrap_err().join("\n");
        assert!(
            problems.contains("Step \"d\" needs a deck to update."),
            "{problems}"
        );
        assert!(
            problems.contains("Step \"d\" needs instructions."),
            "{problems}"
        );
        assert!(
            problems.contains("Step \"w\" needs a draft to update."),
            "{problems}"
        );
        assert!(
            problems.contains(
                "Step \"in\" updates a saved deck, which only works on the steps at the top level"
            ),
            "{problems}"
        );
        let missing =
            parse(r#"{"steps":[{"id":"d","type":"edit_deck","instructions":"Go"}]}"#).unwrap_err();
        assert!(
            missing.ends_with("A step is missing its \"deck\" setting."),
            "{missing}"
        );

        let raw = json!({ "steps": [
            { "id": "d", "type": "edit_deck", "deck": "x", "instructions": "Go", "Input": "y" },
        ]});
        assert_eq!(
            unknown_settings(&raw),
            vec![
                "Step \"d\": unknown setting \"Input\" \u{2014} did you mean \"input\"?"
                    .to_string()
            ]
        );
    }
}
