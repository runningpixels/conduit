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
use super::pace::Pacer;
use super::rules::{self, Act, Decision, Site};
use super::tools::{
    bring_to_front, cdp_error, evaluate, read_checked, settle, AskFn, BrowserAsk, ReadOpts, Tab,
    LOAD_WAIT,
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
/// The person's saved sign-ins, passwords included, read only when needed.
pub type LoginsFn<'a> = dyn Fn() -> Vec<super::signins::SavedLogin> + Send + Sync + 'a;

/// What an agent that may act brings to a browser call.
pub struct ActContext<'a> {
    pub approve: &'a ApproveFn<'a>,
    /// The workflow's site list.
    pub sites: Vec<String>,
    pub secrets: &'a SecretsFn<'a>,
    /// The saved sign-ins `ask_to_sign_in` may use.
    pub logins: &'a LoginsFn<'a>,
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
    pub(super) so_far: Vec<Value>,
    /// Files downloaded and kept in this run.
    pub(super) downloads: usize,
    /// Sites whose downloads were allowed for the rest of this run.
    pub(super) download_hosts: HashSet<String>,
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
            "Click an element of the open page (a link, button, checkbox, tab...). Give its `ref` from the latest elements list and `why`. Returns the page after the click, with fresh elements. Submitting forms, and anything that spends money or changes an account, asks the person first; so does the first action on a site that isn't in the workflow's list. A click that downloads a file asks the person too; a file they allow is attached for you to read (programs and scripts never download).",
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
            "Sign in to the open site when a page needs an account. If the person saved a sign-in for this site, the app fills it in itself (asking them first); otherwise the person signs in themselves in the browser window. You never see or type their password. Give `why`. Returns the page once signed in. If the page then asks for a code or a check, call it again so the person can finish.",
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
    pacer: Pacer<'_>,
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
            pacer.before_action().await;
            for (share, wait) in pacer.scroll_steps() {
                pacer.wait(wait).await;
                evaluate(tab, &elements::scroll_script(down, share)).await?;
            }
            settle(tab).await?;
        }
        GO_BACK_TOOL => {
            pacer.before_action().await;
            go_back(tab).await?
        }
        SIGN_IN_TOOL => {
            if let Some(note) = sign_in(tab, ask, why.as_deref(), ctx, state).await? {
                done["signedIn"] = json!(note);
            }
        }
        CLICK_TOOL | TYPE_TOOL | CHOOSE_TOOL => {
            let element = on_element(tab, name, arguments, why.clone(), ctx, state, pacer).await?;
            done["elementName"] = json!(element.name);
            done["elementRole"] = json!(element.role);
        }
        other => {
            return Err(BrowserError::Other(format!(
                "{other} is not a browser action"
            )))
        }
    }
    pacer.after_action().await;
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
    if let Some(note) = done.get("signedIn").cloned() {
        result["signedIn"] = note;
    }
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
    pacer: Pacer<'_>,
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
                file_name: None,
                file_size: None,
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

    pacer.before_action().await;
    match act {
        Act::Click => click(tab, reference, pacer).await?,
        Act::Type { text, press_enter } => {
            type_into(tab, reference, text, press_enter, pacer).await?
        }
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

async fn click(tab: &Tab, reference: &str, pacer: Pacer<'_>) -> Result<(), BrowserError> {
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
    pacer.hover().await;
    input(tab, "Input.dispatchMouseEvent", mouse("mousePressed")).await?;
    input(tab, "Input.dispatchMouseEvent", mouse("mouseReleased")).await?;
    after_action(tab).await
}

async fn type_into(
    tab: &Tab,
    reference: &str,
    text: &str,
    press_enter: bool,
    pacer: Pacer<'_>,
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
    // A few characters at a time at Human pace (insertText still: no key
    // events, any language).
    if !text.is_empty() {
        for (piece, wait) in pacer.typing(text) {
            pacer.wait(wait).await;
            input(tab, "Input.insertText", json!({ "text": piece })).await?;
        }
    }
    if press_enter {
        press_enter_key(tab).await?;
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

/// `ask_to_sign_in`: with a saved sign-in for the page's site, the app fills
/// it in itself (asking first when someone is there; when nobody is, only if
/// the sign-in allows it). Otherwise, or when that doesn't get through, the
/// person signs in in the window and nothing reads the page meanwhile. Some
/// note comes back for the model when the saved sign-in was used.
async fn sign_in<'a>(
    tab: &Tab,
    ask: Option<&'a AskFn<'a>>,
    why: Option<&str>,
    ctx: &ActContext<'_>,
    state: &std::sync::Mutex<ActState>,
) -> Result<Option<String>, BrowserError> {
    let found = find_login(tab).await?;
    let site = if found.host.is_empty() {
        "the site".to_string()
    } else {
        rules::site_to_offer(&found.host)
    };
    let saved = if found.https && (found.user || found.pass) {
        super::signins::for_host((ctx.logins)(), &found.host)
    } else {
        None
    };
    let mut saved_failed = false;
    if let Some(login) = saved {
        if ask.is_none() && !login.entry.unattended {
            return Err(BrowserError::Other(format!(
                "Signing in to {site} needs the person: their saved sign-in for it isn't allowed in runs nobody is watching. Carry on without signing in, or stop."
            )));
        }
        if ask.is_some() {
            let page: Value = serde_json::from_str(
                &evaluate(tab, "JSON.stringify({u: location.href, t: document.title})").await?,
            )
            .unwrap_or_default();
            let request = BrowserRequest {
                action: "sign_in".to_string(),
                host: found.host.clone(),
                page_url: page["u"].as_str().unwrap_or_default().to_string(),
                page_title: page["t"].as_str().unwrap_or_default().to_string(),
                element_role: None,
                element_name: Some(login.entry.username.clone()),
                text: None,
                option: None,
                why: why.map(str::to_string),
                reason: provider_core::schema::BrowserAskReason::SignIn,
                risky_word: None,
                read_before: ctx.read_before.clone(),
                so_far: state.lock().map(|s| s.so_far.clone()).unwrap_or_default(),
                offer_site: None,
                file_name: None,
                file_size: None,
            };
            if let Approval::No(why) = (ctx.approve)(request).await {
                return Err(BrowserError::Other(why));
            }
        }
        match fill_saved(tab, &login).await? {
            Filled::SignedIn => {
                return Ok(Some(format!(
                    "Signed in to {site} as {} with the person's saved sign-in.",
                    login.entry.username
                )))
            }
            Filled::NotThrough | Filled::NoForm if ask.is_none() => {
                return Err(BrowserError::Other(format!(
                    "The saved sign-in for {site} didn't get through (the site may want a code or a check, or the password changed), and nobody is watching this run to finish it. Carry on without signing in, or stop."
                )));
            }
            Filled::NotThrough | Filled::NoForm => {
                saved_failed = true;
            }
        }
    }
    hand_over(tab, ask, why, &site, saved_failed).await?;
    Ok(None)
}

/// The person signs in in the window; nothing reads the page meanwhile.
async fn hand_over<'a>(
    tab: &Tab,
    ask: Option<&'a AskFn<'a>>,
    why: Option<&str>,
    site: &str,
    after_saved_failed: bool,
) -> Result<(), BrowserError> {
    let Some(ask) = ask else {
        return Err(BrowserError::Other(
            "Signing in needs a person, and nobody is watching this run. Carry on without signing in, or stop.".to_string(),
        ));
    };
    bring_to_front(tab).await;
    if after_saved_failed {
        let text = format!(
            "The saved sign-in for {site} didn't get through. Finish signing in in the agent's browser window, then choose Continue."
        );
        let question =
            BrowserAsk::new(text, "chat.browser.question.signInRetry", &[("site", site)]);
        if !ask(question, DONT_SIGN_IN).await {
            return Err(BrowserError::Other(
                "The person didn't sign in. Carry on without it, or stop.".to_string(),
            ));
        }
        return settle(tab).await;
    }
    let mut text = format!(
        "Sign in to {site} in the agent's browser window, then choose Continue. The agent doesn't see what you type."
    );
    if let Some(why) = why {
        text.push_str(&format!(" It says: {why}"));
    }
    let question = match why {
        Some(why) => BrowserAsk::new(
            text,
            "chat.browser.question.signInWhy",
            &[("site", site), ("why", why)],
        ),
        None => BrowserAsk::new(text, "chat.browser.question.signIn", &[("site", site)]),
    };
    if !ask(question, DONT_SIGN_IN).await {
        return Err(BrowserError::Other(
            "The person didn't sign in. Carry on without it, or stop.".to_string(),
        ));
    }
    settle(tab).await
}

/// The sign-in fields of the open page, as [`LOGIN_SCRIPT`] found them.
#[derive(Debug, Default)]
struct LoginForm {
    https: bool,
    host: String,
    user: bool,
    pass: bool,
    /// A sign-in button was found next to the fields (marked `send`).
    send: bool,
}

/// How filling in a saved sign-in went.
#[derive(Debug, PartialEq, Eq)]
enum Filled {
    SignedIn,
    /// A password field is still there afterwards.
    NotThrough,
    /// No sign-in form on the page (or it moved to another site).
    NoForm,
}

/// Finds the visible password field of the top page and the username field
/// that goes with it (by `autocomplete`, else the text field before it in its
/// form), or a lone username field on a first step, and marks them
/// `data-conduit-login`. Frames are never looked into.
const LOGIN_SCRIPT: &str = r#"(() => { try {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly; };
  document.querySelectorAll('[data-conduit-login]').forEach((e) => e.removeAttribute('data-conduit-login'));
  const inputs = [...document.querySelectorAll('input')].filter(shown);
  const kind = (i) => (i.type || 'text').toLowerCase();
  const ac = (i) => (i.getAttribute('autocomplete') || '').toLowerCase();
  const texty = (i) => ['text', 'email', 'tel'].includes(kind(i));
  const words = (i) => [i.name, i.id, i.getAttribute('aria-label'), i.placeholder].join(' ');
  const pass = inputs.find((i) => kind(i) === 'password' && !ac(i).includes('new-password'));
  let user = inputs.find((i) => texty(i) && /\b(username|email)\b/.test(ac(i)) && (!pass || !pass.form || i.form === pass.form));
  if (!user && pass) {
    const before = inputs.filter((i) => texty(i) && (!pass.form || i.form === pass.form)
      && (i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING));
    user = before[before.length - 1];
  }
  if (!user && !pass) {
    user = inputs.find((i) => texty(i) && /user|login|identifier|e-?mail|account/i.test(words(i)) && !/search|newsletter|subscribe/i.test(words(i)));
  }
  if (user) user.setAttribute('data-conduit-login', 'user');
  if (pass) pass.setAttribute('data-conduit-login', 'pass');
  const last = pass || user;
  let send = null;
  if (last) {
    const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
    const other = /forgot|reset|show|hide|reveal|google|apple|facebook|github|microsoft|twitter|passkey|sign ?up|register|create|cancel|back/i;
    const shownEl = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
    if (last.form) {
      send = [...last.form.querySelectorAll('button, input[type=submit], input[type=image]')]
        .filter((b) => shownEl(b) && (b.tagName !== 'BUTTON' || (b.getAttribute('type') || 'submit').toLowerCase() === 'submit') && !other.test(label(b)))[0] || null;
    } else {
      const named = /sign ?in|log ?in|submit|continue|next|anmelden|einloggen|weiter|connexion|se connecter|continuer|suivant|iniciar|entrar|continuar|siguiente|ログイン|次へ|로그인|다음|登录|下一步/i;
      for (let box = last.parentElement, up = 0; box && box !== document.body && up < 6; box = box.parentElement, up++) {
        const after = [...box.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')]
          .filter((b) => shownEl(b) && (last.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !other.test(label(b)));
        send = after.find((b) => named.test(label(b))) || (after.length === 1 ? after[0] : null);
        if (send || after.length > 1) break;
      }
    }
    if (send) send.setAttribute('data-conduit-login', 'send');
  }
  return JSON.stringify({ https: location.protocol === 'https:', host: location.hostname, user: !!user, pass: !!pass, send: !!send });
} catch (e) { return '{}'; } })()"#;

async fn find_login(tab: &Tab) -> Result<LoginForm, BrowserError> {
    let raw: Value = serde_json::from_str(&evaluate(tab, LOGIN_SCRIPT).await?).unwrap_or_default();
    let host = raw["host"].as_str().unwrap_or_default().to_lowercase();
    Ok(LoginForm {
        https: raw["https"].as_bool().unwrap_or(false) || plain_http_allowed(&host),
        host,
        user: raw["user"].as_bool().unwrap_or(false),
        pass: raw["pass"].as_bool().unwrap_or(false),
        send: raw["send"].as_bool().unwrap_or(false),
    })
}

/// Where the marked sign-in button is, scrolled into view, while the page is
/// still on `host` over https.
fn locate_send_script(host: &str) -> String {
    let secure = if plain_http_allowed(host) {
        "true"
    } else {
        "location.protocol === 'https:'"
    };
    let host = serde_json::to_string(host).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  if (!({secure}) || location.hostname !== {host}) return '{{}}';
  const el = document.querySelector('[data-conduit-login="send"]');
  if (!el || !el.isConnected) return '{{}}';
  el.scrollIntoView({{ block: 'center', inline: 'center' }});
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return '{{}}';
  return JSON.stringify({{ x: r.left + r.width / 2, y: r.top + r.height / 2 }});
}})()"#
    )
}

/// Send the filled-in fields: click the sign-in button found next to them,
/// or press Enter when there is none (or it went).
async fn send_login(tab: &Tab, form: &LoginForm) -> Result<(), BrowserError> {
    if form.send {
        let at: Value =
            serde_json::from_str(&evaluate(tab, &locate_send_script(&form.host)).await?)
                .unwrap_or_default();
        if let (Some(x), Some(y)) = (at["x"].as_f64(), at["y"].as_f64()) {
            let mouse = |kind: &str| json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 });
            input(
                tab,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": x, "y": y }),
            )
            .await?;
            input(tab, "Input.dispatchMouseEvent", mouse("mousePressed")).await?;
            input(tab, "Input.dispatchMouseEvent", mouse("mouseReleased")).await?;
            return after_action(tab).await;
        }
    }
    press_enter_key(tab).await
}

/// Plain http for a sign-in only on the integration test's loopback server
/// (debug builds with the loopback switch on); everywhere else, https.
fn plain_http_allowed(host: &str) -> bool {
    super::guard::loopback_allowed() && host == "127.0.0.1"
}

/// Focuses and empties the marked field, but only while the page is still
/// on `host` over https.
fn focus_login_script(kind: &str, host: &str) -> String {
    let secure = if plain_http_allowed(host) {
        "true"
    } else {
        "location.protocol === 'https:'"
    };
    let host = serde_json::to_string(host).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  if (!({secure}) || location.hostname !== {host}) return 'moved';
  const el = document.querySelector('[data-conduit-login="{kind}"]');
  if (!el || !el.isConnected) return 'gone';
  el.focus();
  if (el.value !== '') {{
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  }}
  return document.activeElement === el ? 'ok' : 'gone';
}})()"#
    )
}

/// Type `value` into the marked field; `false` when the page moved on or
/// the field went.
async fn fill_field(tab: &Tab, kind: &str, host: &str, value: &str) -> Result<bool, BrowserError> {
    if evaluate(tab, &focus_login_script(kind, host)).await? != "ok" {
        return Ok(false);
    }
    input(tab, "Input.insertText", json!({ "text": value })).await?;
    Ok(true)
}

async fn press_enter_key(tab: &Tab) -> Result<(), BrowserError> {
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
    after_action(tab).await
}

/// Fill in and send a saved sign-in: username and password together, or a
/// username step and then a password step. Every field is checked to be on
/// the saved site, over https, right before it is typed into.
async fn fill_saved(tab: &Tab, login: &super::signins::SavedLogin) -> Result<Filled, BrowserError> {
    let mut form = find_login(tab).await?;
    for _step in 0..2 {
        if !form.https || !login.entry.covers(&form.host) || !(form.user || form.pass) {
            return Ok(Filled::NoForm);
        }
        let host = form.host.clone();
        if form.user && !fill_field(tab, "user", &host, &login.entry.username).await? {
            return Ok(Filled::NoForm);
        }
        if form.pass {
            if !fill_field(tab, "pass", &host, &login.password).await? {
                return Ok(Filled::NoForm);
            }
            send_login(tab, &form).await?;
            let after = find_login(tab).await?;
            return Ok(if after.pass && login.entry.covers(&after.host) {
                Filled::NotThrough
            } else {
                Filled::SignedIn
            });
        }
        // A username step: send it and look for the password step.
        send_login(tab, &form).await?;
        form = find_login(tab).await?;
        if !form.pass {
            return Ok(Filled::NotThrough);
        }
    }
    Ok(Filled::NotThrough)
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
