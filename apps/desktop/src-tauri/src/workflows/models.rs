//! Which model a workflow's summarize and agent steps call: the step's own,
//! else the workflow's, else the chat's active one.
//!
//! A choice whose provider is no longer set up (key removed, provider gone)
//! isn't an error: the active model is used instead and the step records why.

use super::definition::ModelChoice;

/// The provider and model one step actually uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub provider: String,
    pub model: String,
    /// Why the chosen model wasn't used; `None` when it was (or none was chosen).
    pub note: Option<String>,
    /// Whether a step or workflow choice is what's used (so the call names
    /// its provider instead of following the settings').
    pub chosen: bool,
}

impl Resolved {
    /// The provider and model as the step's recorded `model` output.
    pub fn output(&self) -> serde_json::Value {
        serde_json::json!({ "provider": self.provider, "model": self.model })
    }
}

/// Step choice, else workflow choice, else the active model. `configured`
/// says whether a provider can be called at all.
pub fn resolve(
    step: Option<&ModelChoice>,
    workflow: Option<&ModelChoice>,
    active_provider: &str,
    active_model: &str,
    configured: &dyn Fn(&str) -> bool,
) -> Resolved {
    let active = |note| Resolved {
        provider: active_provider.to_string(),
        model: active_model.to_string(),
        note,
        chosen: false,
    };
    let Some(choice) = step.or(workflow) else {
        return active(None);
    };
    if choice.provider == active_provider || configured(&choice.provider) {
        return Resolved {
            provider: choice.provider.clone(),
            model: choice.model.clone(),
            note: None,
            chosen: true,
        };
    }
    active(Some(format!(
        "{} isn't set up, so the chat model was used.",
        provider_label(&choice.provider)
    )))
}

/// The provider's display name ("OpenRouter"), or its id when unknown.
pub fn provider_label(provider: &str) -> String {
    provider_core::descriptor(provider)
        .map(|d| d.display_name.to_string())
        .unwrap_or_else(|| provider.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(provider: &str, model: &str) -> ModelChoice {
        ModelChoice {
            provider: provider.into(),
            model: model.into(),
        }
    }

    #[test]
    fn the_step_beats_the_workflow_beats_the_active_model() {
        let all = |_: &str| true;
        let (step, workflow) = (choice("openai", "s"), choice("groq", "w"));
        let got = resolve(Some(&step), Some(&workflow), "ollama", "a", &all);
        assert_eq!((got.provider.as_str(), got.model.as_str()), ("openai", "s"));
        let got = resolve(None, Some(&workflow), "ollama", "a", &all);
        assert_eq!((got.provider.as_str(), got.model.as_str()), ("groq", "w"));
        let got = resolve(None, None, "ollama", "a", &all);
        assert_eq!((got.provider.as_str(), got.model.as_str()), ("ollama", "a"));
        assert_eq!(got.note, None);
    }

    #[test]
    fn a_provider_that_is_not_set_up_falls_back_with_a_note() {
        let step = choice("openrouter", "m");
        let got = resolve(Some(&step), None, "ollama", "a", &|_| false);
        assert_eq!((got.provider.as_str(), got.model.as_str()), ("ollama", "a"));
        assert_eq!(
            got.note.as_deref(),
            Some("OpenRouter isn't set up, so the chat model was used.")
        );
    }
}
