// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Clicking, typing, choosing, scrolling, going back and the sign-in
//! hand-over (design B2 §2–§4), for agents with the `browser_act` marker.
//!
//! Every action on an element is judged by [`super::rules`] first. An action
//! that must ask goes to the person through the runner's `approve` callback
//! (the browser card). Clicks and Enter are real input events, not script
//! calls. After an action the page settles and comes back as a short read
//! with its elements.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::Instant;

use super::elements::{self, Element};
use super::rules::{self, Act, Decision, Site};
use super::tools::{
    bring_to_front, cdp_error, evaluate, read_checked, settle, AskFn, ReadOpts, Tab, LOAD_WAIT,
};
use super::BrowserError;
use crate::workflows::actions::BrowserRequest;

pub const CLICK_TOOL: &str = "click";
pub const TYPE_TOOL: &str = "type_text";
pub const CHOOSE_TOOL: &str = "choose_option";
pub const SCROLL_TOOL: &str = "scroll";
pub const GO_BACK_TOOL: &str = "go_back";
pub const SIGN_IN_TOOL: &str = "ask_to_sign_in";

/// How much text an action's read returns.
const ACTION_READ_CHARS: usize = 4000;

/// The declining choice of the sign-in question.
pub const DONT_SIGN_IN: &str = "Don't sign in";

pub const PAGE_CHANGED: &str =
    "That element is no longer on the page; the page changed. Call read_page and use a ref from its new elements list.";

/// Whether `name` is one of the action tools.
pub fn is_action_tool(name: &str) -> bool {
    matches!(
        name,
        CLICK_TOOL | TYPE_TOOL | CHOOSE_TOOL | SCROLL_TOOL | GO_BACK_TOOL | SIGN_IN_TOOL
    )
}

/// The person's answer to a browser card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Approval {
    /// Do it; `remember` when they chose "Always on this site" (the runner
    /// has added it to the list).
    Go { remember: bool },
    /// Not done; the text is for the model.
    No(String),
}

pub type ApproveFuture<'a> = Pin<Box<dyn Future<Output = Approval> + Send + 'a>>;
/// Shows the browser card and waits for the answer.
pub type ApproveFn<'a> = dyn Fn(BrowserRequest) -> ApproveFuture<'a> + Send + Sync + 'a;
/// The person's saved API keys, read only when text is about to be typed.
pub type SecretsFn<'a> = dyn Fn() -> Vec<String> + Send + Sync + 'a;

/// What an agent that may act brings to a browser call.
pub struct ActContext<'a> {
    pub approve: &'a ApproveFn<'a>,
    /// The workflow's site list.
    pub sites: Vec<String>,
    pub secrets: &'a SecretsFn<'a>,
    /// What the agent read from outside before, for the card.
    pub read_before: Option<String>,
}

/// A run's memory of its browser actions.
#[derive(Debug, Default)]
pub struct ActState {
    /// The elements of the last read, by ref.
    elements: Vec<Element>,
    /// Hosts allowed once in this run (or added to the list during it).
    allowed_hosts: HashSet<String>,
    /// What was done, oldest first, for the card.
    so_far: Vec<Value>,
}

/// The action tools, as the model sees them.
pub fn tool_definitions() -> Vec<provider_core::schema::ToolDefinition> {
    let tool =
        |name: &str, description: &str, schema: Value| provider_core::schema::ToolDefinition {
            tool_id: name.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            input_schema: schema,
            kind: None,
            host_config: None,
            permission_level: None,
            display_group: None,
            tenant_scope: None,
        };
    let why = json!({ "type": "string", "description": "One short sentence: what this is for. The person sees it." });
    let reference = json!({ "type": "string", "description": "The element's ref from the page's elements list, like \"e12\"." });
    vec![
        tool(
            CLICK_TOOL,
            "Click an element of the open page (a link, button, checkbox, tab...). Give its `ref` from the latest elements list and `why`. Returns the page after the click, with fresh elements. Submitting forms, and anything that spends money or changes an account, asks the person first; so does the first action on a site that isn't in the workflow's list.",
            json!({ "type": "object", "properties": { "ref": reference, "why": why }, "required": ["ref", "why"] }),
        ),
        tool(
            TYPE_TOOL,
            "Type text into a field of the open page, replacing what's there. Give the field's `ref`, the `text` and `why`; set `press_enter` to submit (for example a search box). Never type passwords or keys: password fields are refused; use ask_to_sign_in instead. Returns the page afterwards, with fresh elements.",
            json!({
                "type": "object",
                "properties": {
                    "ref": reference,
                    "text": { "type": "string", "description": "What to type." },
                    "press_enter": { "type": "boolean", "description": "Press Enter after typing." },
                    "why": why
                },
                "required": ["ref", "text", "why"]
            }),
        ),
        tool(
            CHOOSE_TOOL,
            "Choose an option in a drop-down list of the open page. Give the list's `ref`, the `option` (its text as shown in the elements list) and `why`. Returns the page afterwards.",
            json!({
                "type": "object",
                "properties": {
                    "ref": reference,
                    "option": { "type": "string", "description": "The option's text." },
                    "why": why
                },
                "required": ["ref", "option", "why"]
            }),
        ),
        tool(
            SCROLL_TOOL,
            "Scroll the open page by one screen, for pages that load more as you scroll. Returns the page afterwards.",
            json!({
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["down", "up"], "description": "Default down." },
                    "why": why
                }
            }),
        ),
        tool(
            GO_BACK_TOOL,
            "Go back to the previous page in this tab. Returns that page.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            SIGN_IN_TOOL,
            "Ask the person to sign in to the open site themselves, in the browser window. Use it when a page needs an account. You never see or type their password. Give `why`. Returns the page once they're done.",
            json!({ "type": "object", "properties": { "why": why }, "required": ["why"] }),
        ),
    ]
}

/// The note added to the system prompt of an agent that may act.
pub const ACT_SYSTEM: &str = "You can also act on pages: click, type_text, choose_option, scroll, go_back and ask_to_sign_in. Pages come back with an `elements` list; each has a `ref` (like e12) to act on, plus its role, name and value. Refs change whenever the page is read, so always use the latest list. Give a short `why` with each action: the person sees it. Some actions ask the person first, and they may say no; then don't try again, find another way or stop. Never type passwords or keys, and never buy, pay, sign up or delete anything unless the task says so.";

/// Add the page's elements to a read, and keep them for the next action.
pub(super) async fn with_elements(
    tab: &Tab,
    result: &mut Value,
    state: &std::sync::Mutex<ActState>,
) -> Result<(), BrowserError> {
    let raw = evaluate(tab, elements::ELEMENTS_SCRIPT).await?;
    let list = elements::parse(&raw);
    result["elements"] = Value::Array(list.iter().map(Element::for_model).collect());
    if let Ok(mut state) = state.lock() {
        state.elements = list;
    }
    Ok(())
}

/// Run one action tool.
pub(super) async fn act<'a>(
    tab: &Tab,
    name: &str,
    arguments: &Value,
    ask: Option<&'a AskFn<'a>>,
    ctx: &ActContext<'_>,
    state: &std::sync::Mutex<ActState>,
) -> Result<Value, BrowserError> {
    let why = arguments["why"]
        .as_str()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map(str::to_string);
    let mut done = json!({ "action": name });
    match name {
        SCROLL_TOOL => {
            let down = arguments["direction"].as_str() != Some("up");
            evaluate(tab, &elements::scroll_script(down)).await?;
            settle(tab).await?;
        }
        GO_BACK_TOOL => go_back(tab).await?,
        SIGN_IN_TOOL => sign_in(tab, ask, why.as_deref()).await?,
        CLICK_TOOL | TYPE_TOOL | CHOOSE_TOOL => {
            let element = on_element(tab, name, arguments, why.clone(), ctx, state).await?;
            done["elementName"] = json!(element.name);
            done["elementRole"] = json!(element.role);
        }
        other => {
            return Err(BrowserError::Other(format!(
                "{other} is not a browser action"
            )))
        }
    }
    let mut result = read_checked(
        tab,
        ask,
        ReadOpts {
            max_chars: ACTION_READ_CHARS,
            whole: false,
        },
    )
    .await?;
    with_elements(tab, &mut result, state).await?;
    done["url"] = result["url"].clone();
    if let Ok(mut state) = state.lock() {
        state.so_far.push(done);
    }
    Ok(result)
}

/// Judge, perhaps ask, then do a click, typing or choice; the element acted
/// on comes back for the record.
async fn on_element(
    tab: &Tab,
    name: &str,
    arguments: &Value,
    why: Option<String>,
    ctx: &ActContext<'_>,
    state: &std::sync::Mutex<ActState>,
) -> Result<Element, BrowserError> {
    let reference = arguments["ref"].as_str().unwrap_or_default().trim();
    if !elements::valid_ref(reference) {
        return Err(BrowserError::Other(
            "Give the element's ref from the page's elements list, like \"e12\".".to_string(),
        ));
    }
    let element = state
        .lock()
        .ok()
        .and_then(|s| {
            s.elements
                .iter()
                .find(|e| e.reference == reference)
                .cloned()
        })
        .ok_or_else(|| BrowserError::Other(PAGE_CHANGED.to_string()))?;
    let text = arguments["text"].as_str().unwrap_or_default();
    let option = arguments["option"].as_str().unwrap_or_default();
    let press_enter = matches!(arguments["press_enter"], Value::Bool(true))
        || arguments["press_enter"].as_str() == Some("true");
    let act = match name {
        CLICK_TOOL => Act::Click,
        TYPE_TOOL => Act::Type { text, press_enter },
        _ => {
            if option.trim().is_empty() {
                return Err(BrowserError::Other(
                    "Say which option to choose, as \"option\".".to_string(),
                ));
            }
            Act::Choose
        }
    };

    let page: Value = serde_json::from_str(
        &evaluate(
            tab,
            "JSON.stringify({u: location.href, h: location.hostname, t: document.title})",
        )
        .await?,
    )
    .unwrap_or_default();
    let host = page["h"].as_str().unwrap_or_default().to_lowercase();
    let offer = rules::site_to_offer(&host);
    let site = if rules::site_listed(&host, &ctx.sites) {
        Site::Listed
    } else if state
        .lock()
        .map(|s| s.allowed_hosts.contains(&offer))
        .unwrap_or(false)
    {
        Site::AllowedThisRun
    } else {
        Site::New
    };
    let secrets = if matches!(act, Act::Type { .. }) {
        (ctx.secrets)()
    } else {
        Vec::new()
    };
    match rules::judge(act, Some(&element.facts()), site, &secrets) {
        Decision::Go => {}
        Decision::Refuse(why) => return Err(BrowserError::Other(why)),
        Decision::Ask {
            reason,
            word,
            offer_site,
        } => {
            let request = BrowserRequest {
                action: name.to_string(),
                host: host.clone(),
                page_url: page["u"].as_str().unwrap_or_default().to_string(),
                page_title: page["t"].as_str().unwrap_or_default().to_string(),
                element_role: Some(element.role.clone()),
                element_name: Some(element.name.clone()),
                text: matches!(act, Act::Type { .. }).then(|| text.to_string()),
                option: matches!(act, Act::Choose).then(|| option.to_string()),
                why,
                reason,
                risky_word: word,
                read_before: ctx.read_before.clone(),
                so_far: state.lock().map(|s| s.so_far.clone()).unwrap_or_default(),
                offer_site: offer_site.then(|| offer.clone()),
            };
            match (ctx.approve)(request).await {
                Approval::No(why) => return Err(BrowserError::Other(why)),
                Approval::Go { .. } => {
                    if offer_site {
                        if let Ok(mut state) = state.lock() {
                            state.allowed_hosts.insert(offer);
                        }
                    }
                }
            }
        }
    }

    match act {
        Act::Click => click(tab, reference).await?,
        Act::Type { text, press_enter } => type_into(tab, reference, text, press_enter).await?,
        _ => choose(tab, reference, option).await?,
    }
    Ok(element)
}

async fn input(tab: &Tab, method: &str, params: Value) -> Result<(), BrowserError> {
    tab.cdp
        .call(method, params, Some(&tab.session))
        .await
        .map(|_| ())
        .map_err(cdp_error)
}

async fn click(tab: &Tab, reference: &str) -> Result<(), BrowserError> {
    let at: Value =
        serde_json::from_str(&evaluate(tab, &elements::locate_script(reference)).await?)
            .unwrap_or_default();
    match at["error"].as_str() {
        Some("hidden") => {
            return Err(BrowserError::Other(
                "That element can't be seen on the page now. Call read_page and try another."
                    .to_string(),
            ))
        }
        Some(_) => return Err(BrowserError::Other(PAGE_CHANGED.to_string())),
        None => {}
    }
    let (Some(x), Some(y)) = (at["x"].as_f64(), at["y"].as_f64()) else {
        return Err(BrowserError::Other(PAGE_CHANGED.to_string()));
    };
    let mouse = |kind: &str| json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 });
    input(
        tab,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": x, "y": y }),
    )
    .await?;
    input(tab, "Input.dispatchMouseEvent", mouse("mousePressed")).await?;
    input(tab, "Input.dispatchMouseEvent", mouse("mouseReleased")).await?;
    after_action(tab).await
}

async fn type_into(
    tab: &Tab,
    reference: &str,
    text: &str,
    press_enter: bool,
) -> Result<(), BrowserError> {
    match evaluate(tab, &elements::clear_script(reference))
        .await?
        .as_str()
    {
        "ok" => {}
        "password" => return Err(BrowserError::Other(rules::PASSWORD_REFUSAL.to_string())),
        "not-a-field" => {
            return Err(BrowserError::Other(
                "That element isn't a field you can type into.".to_string(),
            ))
        }
        _ => return Err(BrowserError::Other(PAGE_CHANGED.to_string())),
    }
    if !text.is_empty() {
        input(tab, "Input.insertText", json!({ "text": text })).await?;
    }
    if press_enter {
        let key = |kind: &str| {
            json!({
                "type": kind, "key": "Enter", "code": "Enter",
                "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13, "text": "\r"
            })
        };
        input(tab, "Input.dispatchKeyEvent", key("keyDown")).await?;
        let mut up = key("keyUp");
        up.as_object_mut().map(|o| o.remove("text"));
        input(tab, "Input.dispatchKeyEvent", up).await?;
        after_action(tab).await?;
    }
    Ok(())
}

async fn choose(tab: &Tab, reference: &str, option: &str) -> Result<(), BrowserError> {
    let answer: Value =
        serde_json::from_str(&evaluate(tab, &elements::choose_script(reference, option)).await?)
            .unwrap_or_default();
    match answer["error"].as_str() {
        None if answer["chosen"].is_string() => after_action(tab).await,
        Some("no-option") => Err(BrowserError::Other(format!(
            "That list has no option “{option}”. Its options: {}.",
            answer["options"]
                .as_array()
                .map(|o| o
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "))
                .unwrap_or_default()
        ))),
        Some("not-a-list") => Err(BrowserError::Other(
            "That element isn't a drop-down list; click it instead.".to_string(),
        )),
        _ => Err(BrowserError::Other(PAGE_CHANGED.to_string())),
    }
}

async fn go_back(tab: &Tab) -> Result<(), BrowserError> {
    let history = tab
        .cdp
        .call("Page.getNavigationHistory", json!({}), Some(&tab.session))
        .await
        .map_err(cdp_error)?;
    let index = history["currentIndex"].as_u64().unwrap_or(0) as usize;
    let earlier = index
        .checked_sub(1)
        .and_then(|i| history["entries"].get(i))
        .filter(|entry| {
            entry["url"]
                .as_str()
                .is_some_and(|u| u.starts_with("http://") || u.starts_with("https://"))
        })
        .and_then(|entry| entry["id"].as_i64());
    let Some(entry_id) = earlier else {
        return Err(BrowserError::Other(
            "There's no earlier page in this tab.".to_string(),
        ));
    };
    input(
        tab,
        "Page.navigateToHistoryEntry",
        json!({ "entryId": entry_id }),
    )
    .await?;
    after_action(tab).await
}

/// The sign-in hand-over: the person signs in in the window; nothing reads
/// the page meanwhile.
async fn sign_in<'a>(
    tab: &Tab,
    ask: Option<&'a AskFn<'a>>,
    why: Option<&str>,
) -> Result<(), BrowserError> {
    let Some(ask) = ask else {
        return Err(BrowserError::Other(
            "Signing in needs a person, and nobody is watching this run. Carry on without signing in, or stop.".to_string(),
        ));
    };
    let host = evaluate(tab, "location.hostname").await.unwrap_or_default();
    let site = if host.is_empty() {
        "the site".to_string()
    } else {
        rules::site_to_offer(&host)
    };
    bring_to_front(tab).await;
    let mut question = format!(
        "Sign in to {site} in the agent's browser window, then choose Continue. The agent doesn't see what you type."
    );
    if let Some(why) = why {
        question.push_str(&format!(" It says: {why}"));
    }
    if !ask(question, DONT_SIGN_IN).await {
        return Err(BrowserError::Other(
            "The person didn't sign in. Carry on without it, or stop.".to_string(),
        ));
    }
    settle(tab).await
}

/// After an input event: give the page a moment, wait out any navigation it
/// started, then let it settle.
async fn after_action(tab: &Tab) -> Result<(), BrowserError> {
    tokio::time::sleep(Duration::from_millis(400)).await;
    let began = Instant::now();
    while began.elapsed() < LOAD_WAIT {
        // Mid-navigation the old page's context is gone and this fails.
        if matches!(
            evaluate(tab, "document.readyState").await.as_deref(),
            Ok("complete")
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    settle(tab).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_tools_are_named_and_described() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            [
                CLICK_TOOL,
                TYPE_TOOL,
                CHOOSE_TOOL,
                SCROLL_TOOL,
                GO_BACK_TOOL,
                SIGN_IN_TOOL
            ]
        );
        for name in names {
            assert!(is_action_tool(name));
        }
        assert!(!is_action_tool("open_page"));
        let typing = defs.iter().find(|d| d.name == TYPE_TOOL).unwrap();
        assert_eq!(
            typing.input_schema["required"],
            json!(["ref", "text", "why"])
        );
    }
}
