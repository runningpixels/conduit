//! What a workflow may do when it runs on its own, and asking when it wants
//! more.
//!
//! Nobody is watching a scheduled run, so its permissions are answered before
//! it runs: turning a schedule on shows everything the workflow will be
//! allowed to do ([`required`]) and the user approves that set once. Manual
//! runs ("Run now") aren't gated; the user is there and chose to run it.
//!
//! A scheduled run that reaches something outside its approved set (a site it
//! wasn't approved for, a different model provider after a settings change, an
//! edit that added a step) doesn't fail: it pauses and asks ([`Reviews`]).
//! "Allow once" carries on, "Always allow" also adds it to the approved set,
//! and "Don't allow" fails the step. Nobody answering within a day counts as
//! "Don't allow". The wait is in memory: quitting while a run waits ends it,
//! and at the next launch it's marked failed like any run cut off by a quit.
//!
//! Approving compares sets, not a hash of the definition: an edit that only
//! narrows what the workflow does needs no new approval.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::definition::{Step, StepAction, WorkflowDefinition};
use super::waiting::{Pending, Waiting};

/// One thing a workflow may do unattended.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Permission {
    /// Read pages on this host (fetch URLs whose host is written in the step).
    Host { host: String },
    /// Read pages at whatever addresses this step is given when it runs (its
    /// URLs come from an input or an earlier step, e.g. search results).
    AnyHost { step_id: String },
    /// Search the web with this backend (`duckduckgo`, `brave`, ...).
    WebSearch { backend: String },
    /// Send text to this model provider.
    Model { provider: String },
    /// Save documents.
    SaveDocuments,
}

/// A permission with what the page needs to describe it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionView {
    #[serde(flatten)]
    pub permission: Permission,
    /// Display name of the provider or search backend.
    pub label: Option<String>,
    /// For `model`: the provider runs on this computer.
    pub local: Option<bool>,
}

/// `permission` with its display name (provider, search backend) and, for a
/// model, whether it runs on this computer.
pub fn view(permission: Permission) -> PermissionView {
    let (label, local) = match &permission {
        Permission::Model { provider } => match provider_core::get_adapter(provider) {
            Some(adapter) => (
                Some(adapter.display_name().to_string()),
                Some(adapter.is_local()),
            ),
            None => (Some(provider.clone()), Some(false)),
        },
        Permission::WebSearch { backend } => (
            Some(
                match backend.as_str() {
                    "duckduckgo" => "DuckDuckGo",
                    "brave" => "Brave",
                    "tavily" => "Tavily",
                    "searxng" => "SearXNG",
                    other => other,
                }
                .to_string(),
            ),
            None,
        ),
        _ => (None, None),
    };
    PermissionView {
        permission,
        label,
        local,
    }
}

/// What the current settings answer for the parts of a definition that
/// depend on them.
pub struct Context<'a> {
    pub search_backend: &'a str,
    pub provider: &'a str,
}

/// The host a URL template names, when it is written out rather than filled
/// in at run time: `https://bbc.com/news/{{inputs.topic}}` → `bbc.com`, but
/// `{{item.url}}` or `https://{{inputs.site}}/x` → `None`.
pub fn static_host(template: &str) -> Option<String> {
    let fixed = template.split("{{").next().unwrap_or_default();
    let rest = fixed.trim().split_once("://")?.1;
    let end = rest.find(['/', '?', '#']);
    // The host must end before the first placeholder, or it isn't fixed.
    if end.is_none() && fixed.len() < template.len() {
        return None;
    }
    host_of(&format!("https://{}", &rest[..end.unwrap_or(rest.len())]))
}

/// The lowercased host of a URL, without `www.` so the two spellings of a
/// site are one permission.
pub fn host_of(url: &str) -> Option<String> {
    let host = url::Url::parse(url).ok()?.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    (!host.is_empty()).then_some(host)
}

/// The permission a fetch of `url` (from the template at the same position
/// in `step`) needs.
pub fn for_fetch(step_id: &str, template: &str, url: &str) -> Permission {
    match static_host(template) {
        Some(_) => Permission::Host {
            host: host_of(url).unwrap_or_default(),
        },
        None => Permission::AnyHost {
            step_id: step_id.to_string(),
        },
    }
}

/// Everything `def` needs to run, given today's settings, sorted.
pub fn required(def: &WorkflowDefinition, ctx: &Context) -> Vec<Permission> {
    let mut set = BTreeSet::new();
    collect(&def.steps, ctx, &mut set);
    set.into_iter().collect()
}

fn collect(steps: &[Step], ctx: &Context, set: &mut BTreeSet<Permission>) {
    for step in steps {
        match &step.action {
            StepAction::FetchPage { urls } => {
                for template in urls {
                    set.insert(match static_host(template) {
                        Some(host) => Permission::Host { host },
                        None => Permission::AnyHost {
                            step_id: step.id.clone(),
                        },
                    });
                }
            }
            StepAction::WebSearch { .. } => {
                set.insert(Permission::WebSearch {
                    backend: ctx.search_backend.to_string(),
                });
            }
            StepAction::Summarize { .. } => {
                set.insert(Permission::Model {
                    provider: ctx.provider.to_string(),
                });
            }
            // Notifications stay on this computer.
            StepAction::Template { .. } | StepAction::Notify { .. } | StepAction::Ask { .. } => {}
            StepAction::SaveArtifact { .. } => {
                set.insert(Permission::SaveDocuments);
            }
            StepAction::ForEach { steps, .. } => collect(steps, ctx, set),
        }
    }
}

/// What in `required` isn't in `approved`.
pub fn missing(required: &[Permission], approved: &BTreeSet<Permission>) -> Vec<Permission> {
    required
        .iter()
        .filter(|p| !approved.contains(p))
        .cloned()
        .collect()
}

/// The answer to a paused run's question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    AllowOnce,
    AlwaysAllow,
    Deny,
}

/// A scheduled run waiting for the user.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingReview {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub step_id: String,
    pub permission: PermissionView,
    /// For a fetch: the address it wants, so "any address" reviews name it.
    pub url: Option<String>,
    pub requested_at: String,
    pub expires_at: String,
}

impl Pending for PendingReview {
    fn run_id(&self) -> &str {
        &self.run_id
    }
    fn requested_at(&self) -> &str {
        &self.requested_at
    }
}

/// Scheduled runs waiting for a permission answer, by run id.
pub type Reviews = Waiting<PendingReview, Decision>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(steps: serde_json::Value) -> WorkflowDefinition {
        serde_json::from_value(json!({ "steps": steps })).unwrap()
    }

    const CTX: Context = Context {
        search_backend: "duckduckgo",
        provider: "ollama",
    };

    #[test]
    fn a_host_is_fixed_only_when_written_before_any_placeholder() {
        assert_eq!(
            static_host("https://www.BBC.com/news").as_deref(),
            Some("bbc.com")
        );
        assert_eq!(
            static_host("https://example.com/search?q={{inputs.q}}").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            static_host("https://example.com").as_deref(),
            Some("example.com")
        );
        assert_eq!(static_host("{{item.url}}"), None);
        assert_eq!(static_host("https://{{inputs.site}}/news"), None);
        assert_eq!(static_host("https://news.{{inputs.tld}}"), None);
        assert_eq!(static_host("not a url"), None);
    }

    #[test]
    fn required_lists_every_kind_once_including_inside_for_each() {
        let d = def(json!([
            { "id": "search", "type": "web_search", "query": "rust" },
            { "id": "fetch", "type": "fetch_page", "urls": ["https://bbc.com/a", "https://www.bbc.com/b", "https://nytimes.com"] },
            { "id": "each", "type": "for_each", "items": "steps.search.results", "steps": [
                { "id": "page", "type": "fetch_page", "urls": ["{{item.url}}"] },
                { "id": "sum", "type": "summarize", "prompt": "Sum", "input": "{{steps.page.text}}" },
            ]},
            { "id": "sum2", "type": "summarize", "prompt": "Sum", "input": "x" },
            { "id": "save", "type": "save_artifact", "title": "T", "content": "C" },
        ]));
        assert_eq!(
            required(&d, &CTX),
            vec![
                Permission::Host {
                    host: "bbc.com".into()
                },
                Permission::Host {
                    host: "nytimes.com".into()
                },
                Permission::AnyHost {
                    step_id: "page".into()
                },
                Permission::WebSearch {
                    backend: "duckduckgo".into()
                },
                Permission::Model {
                    provider: "ollama".into()
                },
                Permission::SaveDocuments,
            ]
        );
    }

    #[test]
    fn missing_is_what_an_edit_added_and_narrowing_needs_nothing() {
        let approved: BTreeSet<Permission> = [
            Permission::Host {
                host: "bbc.com".into(),
            },
            Permission::SaveDocuments,
        ]
        .into();
        let narrower = vec![Permission::SaveDocuments];
        assert!(missing(&narrower, &approved).is_empty());
        let wider = vec![
            Permission::Host {
                host: "bbc.com".into(),
            },
            Permission::Model {
                provider: "openai".into(),
            },
        ];
        assert_eq!(
            missing(&wider, &approved),
            vec![Permission::Model {
                provider: "openai".into()
            }]
        );
    }

    #[test]
    fn a_fetch_needs_its_host_or_the_step_s_any_address_permission() {
        assert_eq!(
            for_fetch("fetch", "https://bbc.com/a", "https://www.bbc.com/a"),
            Permission::Host {
                host: "bbc.com".into()
            }
        );
        assert_eq!(
            for_fetch("page", "{{item.url}}", "https://elsewhere.org/x"),
            Permission::AnyHost {
                step_id: "page".into()
            }
        );
    }

    #[test]
    fn permissions_serialize_for_the_page() {
        assert_eq!(
            serde_json::to_value(Permission::AnyHost {
                step_id: "page".into()
            })
            .unwrap(),
            json!({ "kind": "anyHost", "stepId": "page" })
        );
        assert_eq!(
            serde_json::to_value(Permission::SaveDocuments).unwrap(),
            json!({ "kind": "saveDocuments" })
        );
        let back: Permission =
            serde_json::from_value(json!({ "kind": "host", "host": "bbc.com" })).unwrap();
        assert_eq!(
            back,
            Permission::Host {
                host: "bbc.com".into()
            }
        );
    }

    #[tokio::test]
    async fn a_review_is_answered_once_and_listed_until_then() {
        let reviews = Reviews::default();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(0));
        let count = seen.clone();
        reviews.set_listener(move |_| *count.lock().unwrap() += 1);
        let review = PendingReview {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            workflow_name: "Morning".into(),
            step_id: "fetch".into(),
            permission: PermissionView {
                permission: Permission::SaveDocuments,
                label: None,
                local: None,
            },
            url: None,
            requested_at: "2026-09-29T08:00:00.000Z".into(),
            expires_at: "2026-09-30T08:00:00.000Z".into(),
        };
        let rx = reviews.ask(review);
        assert_eq!(*seen.lock().unwrap(), 1);
        assert_eq!(reviews.list().len(), 1);
        assert!(reviews.answer("r1", Decision::AlwaysAllow));
        assert_eq!(rx.await.unwrap(), Decision::AlwaysAllow);
        assert!(reviews.list().is_empty());
        assert!(!reviews.answer("r1", Decision::Deny), "only once");
    }
}
