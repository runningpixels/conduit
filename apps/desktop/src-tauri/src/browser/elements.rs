// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! The things on a page an agent can use (design B2 §1), and the page
//! scripts behind clicking, typing and choosing.
//!
//! [`ELEMENTS_SCRIPT`] numbers the visible, enabled, interactive elements of
//! the top document in order (`data-conduit-ref="e1"`, …) and reports each
//! one's role, accessible name and value, plus the facts the ask rules need
//! (password field, submits a form, ...). The facts stay in Rust; the model
//! sees [`Element::for_model`]. Password values are never read.

use serde::Deserialize;
use serde_json::{json, Value};

use super::rules::ElementFacts;

/// At most this many elements are listed.
pub const MAX_ELEMENTS: usize = 200;
/// At most this many options of a list are shown.
pub const MAX_OPTIONS: usize = 30;

/// One element, as the page script reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Element {
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub options: Option<Vec<String>>,
    pub url: Option<String>,
    pub password: bool,
    pub submits: bool,
    pub in_form: bool,
    pub form_has_password: bool,
    pub submit_name: Option<String>,
}

impl Element {
    /// What the model sees: no facts, no empty fields.
    pub fn for_model(&self) -> Value {
        let mut out = json!({ "ref": self.reference, "role": self.role, "name": self.name });
        if let Some(value) = &self.value {
            out["value"] = json!(value);
        }
        if let Some(options) = &self.options {
            out["options"] = json!(options);
        }
        if let Some(url) = &self.url {
            out["url"] = json!(url);
        }
        out
    }

    /// What the ask rules need.
    pub fn facts(&self) -> ElementFacts {
        ElementFacts {
            role: self.role.clone(),
            name: self.name.clone(),
            password: self.password,
            submits: self.submits,
            in_form: self.in_form,
            form_has_password: self.form_has_password,
            submit_name: self.submit_name.clone(),
        }
    }
}

/// Parse the script's JSON string; anything unreadable is no elements.
pub fn parse(raw: &str) -> Vec<Element> {
    let mut elements: Vec<Element> = serde_json::from_str(raw).unwrap_or_default();
    elements.truncate(MAX_ELEMENTS);
    for element in &mut elements {
        if element.password {
            element.value = None;
        }
        if let Some(options) = &mut element.options {
            options.truncate(MAX_OPTIONS);
        }
    }
    elements
}

/// Whether `reference` looks like one of ours (`e` and a number), so it can
/// go into a selector safely.
pub fn valid_ref(reference: &str) -> bool {
    reference
        .strip_prefix('e')
        .is_some_and(|n| !n.is_empty() && n.len() <= 6 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Numbers the page's interactive elements and returns them as a JSON
/// string. Nothing is left on the page except the `data-conduit-ref`
/// attributes. The scripts below take a ref that passed [`valid_ref`].
pub const ELEMENTS_SCRIPT: &str = r#"(() => {
  const MAX = 200, MAX_OPTIONS = 30;
  for (const old of document.querySelectorAll('[data-conduit-ref]')) old.removeAttribute('data-conduit-ref');
  const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const byIds = (ids) => ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.innerText || e.textContent).join(' ');
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('aria-labelledby')) { const t = byIds(el.getAttribute('aria-labelledby')); if (t.trim()) return t; }
    if (el.labels && el.labels.length) { const t = Array.from(el.labels).map((l) => l.innerText).join(' '); if (t.trim()) return t; }
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return el.value;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      const t = el.innerText || el.textContent; if (t && t.trim()) return t;
      const img = el.querySelector('img[alt]'); if (img) return img.alt;
    }
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'password') return 'password';
      return 'textbox';
    }
    return 'button';
  };
  const submits = (el) => {
    const form = el.form || el.closest('form');
    if (!form) return false;
    if (el.tagName === 'BUTTON') return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
    return el.tagName === 'INPUT' && ['submit', 'image'].includes((el.type || '').toLowerCase());
  };
  const submitName = (form) => {
    const b = form.querySelector('button:not([type]), button[type=submit], input[type=submit], input[type=image]');
    return b ? clip(nameOf(b), 80) : null;
  };
  // Also what pages make clickable by script: links without an address, inline
  // click handlers, focusable elements and the usual button classes.
  const selector = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [contenteditable=""], [contenteditable=true], [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=searchbox], a:not([href]), [onclick], [tabindex]:not([tabindex="-1"]), [data-toggle], [data-bs-toggle], .btn, [class*="button" i]';
  const out = [];
  let n = 0;
  const taken = new Set();
  for (const el of document.querySelectorAll(selector)) {
    if (out.length >= MAX) break;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;
    // A clickable inside one already listed (an icon in a button) is the same thing.
    let inside = false;
    for (let p = el.parentElement; p; p = p.parentElement) if (taken.has(p)) { inside = true; break; }
    if (inside) continue;
    // A wrapper with no text of its own and nothing to name it isn't worth a ref.
    const native = ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role') || el.isContentEditable;
    if (!native && !clip(nameOf(el), 80)) continue;
    // A wrapper holding real controls (a "button-group", a focusable panel) is
    // skipped so the controls inside it are listed instead.
    if (!native && el.querySelector('a[href], button, input, select, textarea, [role=button], [role=link]')) continue;
    taken.add(el);
    const role = roleOf(el);
    const form = el.form || el.closest('form');
    const item = { ref: 'e' + (++n), role, name: clip(nameOf(el), 80) };
    el.setAttribute('data-conduit-ref', item.ref);
    if (role === 'password') item.password = true;
    else if (el.tagName === 'SELECT') {
      const chosen = el.selectedOptions && el.selectedOptions[0];
      item.value = chosen ? clip(chosen.label, 80) : '';
      item.options = Array.from(el.options).slice(0, MAX_OPTIONS).map((o) => clip(o.label, 60));
    } else if (role === 'checkbox' || role === 'radio') {
      item.value = (el.checked || el.getAttribute('aria-checked') === 'true') ? 'checked' : 'unchecked';
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      item.value = clip(el.value, 200);
    } else if (el.isContentEditable) {
      item.value = clip(el.innerText, 200);
    }
    if (el.tagName === 'A' && el.href) item.url = el.href;
    if (submits(el)) item.submits = true;
    if (form) {
      item.inForm = true;
      if (form.querySelector('input[type=password]')) item.formHasPassword = true;
      const s = submitName(form); if (s) item.submitName = s;
    }
    out.push(item);
  }
  return JSON.stringify(out);
})()"#;

/// Finds element `REF`, scrolls it to the middle of the window, drops a link's
/// `target` (pop-ups are closed, so the page opens in this tab), and returns
/// `{x, y}` (the centre, in CSS pixels of the window) or `{error}`.
pub fn locate_script(reference: &str) -> String {
    format!(
        r#"(() => {{
  const el = document.querySelector('[data-conduit-ref="{reference}"]');
  if (!el || !el.isConnected) return JSON.stringify({{ error: 'gone' }});
  el.scrollIntoView({{ block: 'center', inline: 'center' }});
  if (el.tagName === 'A') el.removeAttribute('target');
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return JSON.stringify({{ error: 'hidden' }});
  return JSON.stringify({{ x: r.left + r.width / 2, y: r.top + r.height / 2 }});
}})()"#
    )
}

/// Focuses element `REF` and empties it, ready for `Input.insertText`.
/// Returns `"ok"` or an error word.
pub fn clear_script(reference: &str) -> String {
    format!(
        r#"(() => {{
  const el = document.querySelector('[data-conduit-ref="{reference}"]');
  if (!el || !el.isConnected) return 'gone';
  if (el.type === 'password') return 'password';
  el.focus();
  if (el.isContentEditable) {{
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return 'ok';
  }}
  if (!('value' in el) || el.tagName === 'SELECT' || el.tagName === 'BUTTON') return 'not-a-field';
  if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes((el.type || '').toLowerCase())) return 'not-a-field';
  if (el.value !== '') {{
    // The prototype's setter, so frameworks that watch the value see it.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  }}
  return 'ok';
}})()"#
    )
}

/// Chooses `OPTION` (by label, then by value, ignoring case) in the list
/// `REF`, firing input and change like a person's choice. Returns the chosen
/// label as JSON `{chosen}` or `{error, options}`.
pub fn choose_script(reference: &str, option: &str) -> String {
    let wanted = serde_json::to_string(option).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  const el = document.querySelector('[data-conduit-ref="{reference}"]');
  if (!el || !el.isConnected) return JSON.stringify({{ error: 'gone' }});
  if (el.tagName !== 'SELECT') return JSON.stringify({{ error: 'not-a-list' }});
  const wanted = {wanted}.trim().toLowerCase();
  const opts = Array.from(el.options);
  const found = opts.find((o) => o.label.trim().toLowerCase() === wanted) || opts.find((o) => o.value.trim().toLowerCase() === wanted);
  if (!found) return JSON.stringify({{ error: 'no-option', options: opts.slice(0, 30).map((o) => o.label) }});
  el.focus();
  el.value = found.value;
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  return JSON.stringify({{ chosen: found.label }});
}})()"#
    )
}

/// Scrolls one screen down or up.
pub fn scroll_script(down: bool) -> String {
    let sign = if down { "" } else { "-" };
    format!("(() => {{ window.scrollBy(0, {sign}Math.round(innerHeight * 0.9)); return String(scrollY); }})()")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hides_password_values_and_caps_lists() {
        let options: Vec<String> = (0..50).map(|i| format!("o{i}")).collect();
        let raw = json!([
            { "ref": "e1", "role": "password", "name": "Password", "value": "secret", "password": true, "inForm": true, "formHasPassword": true },
            { "ref": "e2", "role": "combobox", "name": "Country", "value": "Spain", "options": options },
            { "ref": "e3", "role": "link", "name": "Docs", "url": "https://example.com/docs" }
        ])
        .to_string();
        let elements = parse(&raw);
        assert_eq!(elements.len(), 3);
        assert_eq!(elements[0].value, None);
        assert!(elements[0].facts().password);
        assert_eq!(elements[1].options.as_ref().unwrap().len(), MAX_OPTIONS);
        let shown = elements[0].for_model();
        assert_eq!(
            shown,
            json!({ "ref": "e1", "role": "password", "name": "Password" })
        );
        assert_eq!(elements[2].for_model()["url"], "https://example.com/docs");
    }

    #[test]
    fn parse_survives_junk_and_caps_count() {
        assert!(parse("not json").is_empty());
        let many: Vec<Value> = (0..300)
            .map(|i| json!({ "ref": format!("e{i}"), "role": "button", "name": "x" }))
            .collect();
        assert_eq!(parse(&json!(many).to_string()).len(), MAX_ELEMENTS);
    }

    #[test]
    fn refs_are_checked_before_use_in_selectors() {
        assert!(valid_ref("e1"));
        assert!(valid_ref("e200"));
        for bad in ["", "e", "1", "e1\"]", "x1", "e1 e2", "e1234567"] {
            assert!(!valid_ref(bad), "{bad}");
        }
    }

    #[test]
    fn choose_script_quotes_the_option() {
        let script = choose_script("e4", "O'Brien \"quoted\"");
        assert!(script.contains(r#""O'Brien \"quoted\"""#));
    }
}
