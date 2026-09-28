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
    pub steps: Vec<Step>,
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
}

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

/// Parse a stored definition.
pub fn parse(json: &str) -> Result<WorkflowDefinition, String> {
    serde_json::from_str(json).map_err(|e| format!("The workflow definition can't be read: {e}"))
}

/// Every problem with `def`, in plain English, or `Ok` when it can run.
pub fn validate(def: &WorkflowDefinition) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    if def.steps.is_empty() {
        problems.push("A workflow needs at least one step.".to_string());
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
    fn an_unknown_step_type_does_not_parse() {
        assert!(parse(r#"{"steps":[{"id":"a","type":"launch_rockets"}]}"#).is_err());
    }
}
