// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! `look_at_page` (design B3 §1): a picture of the open page for a model
//! that can see images.
//!
//! Tool results are text in every provider adapter, so the picture takes the
//! path images already take: [`store_screenshot`] saves it as an attachment of
//! the conversation, and the continuation request adds it as an image part
//! after the tool result ([`screenshot_message`]). Only the
//! [`SCREENSHOTS_KEPT`] newest stay pictures ([`fade_old_screenshots`]).

use base64::Engine;
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};
use serde_json::{json, Value};

use super::tools::{cdp_error, detect_challenge, evaluate, Check, Tab};
use super::BrowserError;

pub const LOOK_TOOL: &str = "look_at_page";

/// The longest side of a picture, in pixels: within every provider's limits.
const MAX_SIDE: f64 = 1568.0;
/// A whole-page picture is at most this many screens tall.
const MAX_SCREENS: f64 = 3.0;
const JPEG_QUALITY: u32 = 70;
/// Pictures still shown to the model; older ones become a line of text.
pub const SCREENSHOTS_KEPT: usize = 2;
/// Where the picture waits in a tool's output until it is stored.
const PENDING_KEY: &str = "_jpeg";
/// The stored picture's attachment, in the tool's output (kept for the
/// step's thumbnail; taken out of the text the model reads).
pub const SCREENSHOT_ID_KEY: &str = "screenshot_id";
/// Marks the message that carries a picture in a continuation request.
const SCREENSHOT_MARK: &str = "browser_screenshot";
/// The attachment's name.
const FILE_NAME: &str = "page-screenshot.jpg";

/// The tool, as the model sees it. Offered only to models that accept images.
pub fn tool_definition() -> provider_core::schema::ToolDefinition {
    provider_core::schema::ToolDefinition {
        tool_id: LOOK_TOOL.to_string(),
        name: LOOK_TOOL.to_string(),
        description: format!(
            "See the open page as a picture, for what its text doesn't show: charts, maps, images, icon-only buttons, layout and position. Give a short `why`: the person sees it. Returns the page `url`, `title` and the picture's size; the picture follows as an image. When you can click, the elements' refs (like e12) are drawn on it as small tags. Set `full_page` to see up to three screens of the page instead of what is showing. Read the page text with read_page first; look only when the text isn't enough. {}",
            crate::agent_tools::UNTRUSTED_PAGE_SENTENCE
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "why": { "type": "string", "description": "What you want to see, in a few words." },
                "full_page": { "type": "boolean", "description": "See up to three screens from the top of the page instead of the part showing." }
            },
            "required": ["why"]
        }),
        kind: None,
        host_config: None,
        permission_level: None,
        display_group: None,
        tenant_scope: None,
    }
}

/// What the page measures, from [`METRICS_SCRIPT`].
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct Metrics {
    url: String,
    title: String,
    width: f64,
    height: f64,
    scroll_y: f64,
    page_height: f64,
    dpr: f64,
}

const METRICS_SCRIPT: &str = "(function(){try{var d=document.documentElement;return JSON.stringify({url:location.href,title:document.title||'',width:innerWidth,height:innerHeight,scroll_y:scrollY,page_height:Math.max(d?d.scrollHeight:0,document.body?document.body.scrollHeight:0),dpr:devicePixelRatio||1})}catch(e){return ''}})()";

/// Draws each element ref as a small tag at its top-left corner. Nothing but
/// the tags' layer is added, and [`UNTAG_SCRIPT`] removes it.
const TAG_SCRIPT: &str = r#"(function(){try{
  var old=document.getElementById('__conduit_ref_tags'); if(old) old.remove();
  var els=document.querySelectorAll('[data-conduit-ref]'); if(!els.length) return '0';
  var layer=document.createElement('div'); layer.id='__conduit_ref_tags';
  layer.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  var n=0;
  for(var i=0;i<els.length;i++){
    var r=els[i].getBoundingClientRect(); if(r.width<1||r.height<1) continue;
    var t=document.createElement('div'); t.textContent=els[i].getAttribute('data-conduit-ref');
    t.style.cssText='position:absolute;font:bold 11px/13px Arial,sans-serif;color:#fff;background:#d6336c;border-radius:3px;padding:0 3px;white-space:nowrap;box-shadow:0 0 0 1px #fff';
    t.style.left=Math.max(0,r.left+scrollX)+'px'; t.style.top=Math.max(0,r.top+scrollY-2)+'px';
    layer.appendChild(t); n++;
  }
  document.documentElement.appendChild(layer); return String(n);
}catch(e){return '0'}})()"#;

const UNTAG_SCRIPT: &str =
    "(function(){var l=document.getElementById('__conduit_ref_tags');if(l)l.remove();return ''})()";

/// The part of the page to capture, in CSS pixels from the document's top
/// left, and the scale that keeps the picture within [`MAX_SIDE`].
fn clip(m: &Metrics, full_page: bool) -> (f64, f64, f64, f64) {
    let width = m.width.max(1.0);
    let (y, height) = if full_page {
        (0.0, m.page_height.max(m.height).min(m.height * MAX_SCREENS))
    } else {
        (m.scroll_y.max(0.0), m.height)
    };
    let height = height.max(1.0);
    let dpr = if m.dpr > 0.0 { m.dpr } else { 1.0 };
    let scale = (MAX_SIDE / (width.max(height) * dpr)).min(1.0);
    (y, width, height, scale)
}

/// Take the picture. `tags`: draw the element refs on it (for an agent that
/// may act, after its elements were listed).
pub(super) async fn look(tab: &Tab, full_page: bool, tags: bool) -> Result<Value, BrowserError> {
    // A human check is for the person, never for the model to look at.
    if !matches!(detect_challenge(tab).await?, Check::Clear) {
        return Err(BrowserError::Other(
            "This page is a human check or a block page, so it can't be looked at. Call read_page: the person is asked to finish the check.".to_string(),
        ));
    }
    let metrics: Metrics = serde_json::from_str(&evaluate(tab, METRICS_SCRIPT).await?)
        .map_err(|_| BrowserError::Other("the page could not be measured".to_string()))?;
    if !(metrics.url.starts_with("http://") || metrics.url.starts_with("https://")) {
        return Err(BrowserError::Other(
            "no page is open; call open_page first".to_string(),
        ));
    }
    let (y, width, height, scale) = clip(&metrics, full_page);
    if tags {
        evaluate(tab, TAG_SCRIPT).await?;
    }
    let shot = tab
        .cdp
        .call(
            "Page.captureScreenshot",
            json!({
                "format": "jpeg",
                "quality": JPEG_QUALITY,
                "clip": { "x": 0, "y": y, "width": width, "height": height, "scale": scale },
                "captureBeyondViewport": full_page,
            }),
            Some(&tab.session),
        )
        .await;
    if tags {
        let _ = evaluate(tab, UNTAG_SCRIPT).await;
    }
    let shot = shot.map_err(cdp_error)?;
    let data = shot["data"].as_str().unwrap_or_default();
    if data.is_empty() {
        return Err(BrowserError::Other(
            "the browser returned no picture".to_string(),
        ));
    }
    let dpr = if metrics.dpr > 0.0 { metrics.dpr } else { 1.0 };
    Ok(json!({
        "url": metrics.url,
        "title": metrics.title,
        "screenshot": "attached below",
        "width": (width * dpr * scale).round() as u64,
        "height": (height * dpr * scale).round() as u64,
        PENDING_KEY: data,
    }))
}

/// Save the picture a `look_at_page` result carries as an attachment of
/// `conversation_id`, and put its id in its place. Nothing to do for any
/// other result.
pub async fn store_screenshot(
    state: &crate::state::AppState,
    conversation_id: &str,
    result: &mut Value,
) -> Result<(), String> {
    let Some(data) = result.as_object_mut().and_then(|o| o.remove(PENDING_KEY)) else {
        return Ok(());
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_str().unwrap_or_default())
        .map_err(|_| "the picture could not be read".to_string())?;
    let saved = crate::db::repository::attachments::save(
        &state.db,
        &state.paths.attachments,
        &state.encryption,
        conversation_id,
        &bytes,
        "image/jpeg",
        Some(FILE_NAME),
    )
    .await
    .map_err(|e| format!("the picture could not be saved ({e})"))?;
    result[SCREENSHOT_ID_KEY] = Value::String(saved.id);
    Ok(())
}

/// Take a stored picture's id out of a `look_at_page` result, so the text
/// the model reads doesn't carry it. With the page's address, for the note
/// that replaces it later.
pub fn take_screenshot(result: &mut Value) -> Option<(String, String)> {
    let id = result
        .as_object_mut()?
        .remove(SCREENSHOT_ID_KEY)?
        .as_str()?
        .to_string();
    let url = result["url"].as_str().unwrap_or_default().to_string();
    Some((id, url))
}

/// The user message that shows the model a picture, right after the tool
/// results. Not saved: a later turn sees only the tool's text.
pub fn screenshot_message(
    id: &str,
    conversation_id: &str,
    shots: &[(String, String)],
    now: &str,
) -> Message {
    let mut parts = Vec::new();
    for (attachment, url) in shots {
        let mut caption = text_part(
            id,
            parts.len(),
            &format!("The page you looked at ({url}):"),
            now,
        );
        caption.metadata = Some(json!({ "caption": true }));
        parts.push(caption);
        parts.push(MessagePart {
            id: format!("{id}/{}", parts.len()),
            message_id: id.to_string(),
            index: parts.len() as u32,
            kind: MessagePartKind::AttachmentReference,
            content: None,
            mime_type: Some("image/jpeg".to_string()),
            tool_call_id: None,
            artifact_id: None,
            attachment_id: Some(attachment.clone()),
            blob_ref: None,
            metadata: Some(json!({ "url": url })),
            created_at: now.to_string(),
        });
    }
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: Some(json!({ SCREENSHOT_MARK: true })),
        parts,
        created_at: now.to_string(),
    }
}

fn text_part(message_id: &str, index: usize, text: &str, now: &str) -> MessagePart {
    MessagePart {
        id: format!("{message_id}/{index}"),
        message_id: message_id.to_string(),
        index: index as u32,
        kind: MessagePartKind::Text,
        content: Some(text.to_string()),
        mime_type: None,
        tool_call_id: None,
        artifact_id: None,
        attachment_id: None,
        blob_ref: None,
        metadata: None,
        created_at: now.to_string(),
    }
}

/// Keep only the [`SCREENSHOTS_KEPT`] newest pictures: each older one
/// becomes a line saying what it was, so a long run doesn't fill its context
/// with pictures (or hit the per-request image limit, which keeps the oldest).
pub fn fade_old_screenshots(messages: &mut [Message]) {
    let mut seen = 0usize;
    for message in messages.iter_mut().rev() {
        let marked = message
            .metadata
            .as_ref()
            .and_then(|m| m.get(SCREENSHOT_MARK))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !marked || message.role != MessageRole::User {
            continue;
        }
        let images = message
            .parts
            .iter()
            .filter(|p| p.kind == MessagePartKind::AttachmentReference)
            .count();
        if seen >= SCREENSHOTS_KEPT {
            let mut parts = Vec::with_capacity(message.parts.len());
            for part in message.parts.drain(..) {
                if is_caption(&part) {
                    continue;
                }
                if part.kind == MessagePartKind::AttachmentReference {
                    let url = part
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("url"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let mut note = text_part(
                        &message.id,
                        parts.len(),
                        &format!("(An earlier picture of {url}, no longer shown.)"),
                        &part.created_at,
                    );
                    note.id = part.id;
                    parts.push(note);
                } else {
                    parts.push(part);
                }
            }
            for (i, part) in parts.iter_mut().enumerate() {
                part.index = i as u32;
            }
            message.parts = parts;
        }
        seen += images;
    }
}

fn is_caption(part: &MessagePart) -> bool {
    part.kind == MessagePartKind::Text
        && part
            .metadata
            .as_ref()
            .and_then(|m| m.get("caption"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(width: f64, height: f64, page: f64, dpr: f64) -> Metrics {
        Metrics {
            width,
            height,
            page_height: page,
            scroll_y: 400.0,
            dpr,
            ..Metrics::default()
        }
    }

    #[test]
    fn the_visible_part_is_captured_within_the_size_limit() {
        let (y, w, h, scale) = clip(&metrics(1280.0, 800.0, 5000.0, 1.0), false);
        assert_eq!((y, w, h), (400.0, 1280.0, 800.0));
        assert_eq!(scale, 1.0);
        // A high-density screen is scaled down to the limit.
        let (_, _, _, scale) = clip(&metrics(1280.0, 800.0, 5000.0, 2.0), false);
        assert!((1280.0 * 2.0 * scale - MAX_SIDE).abs() < 0.01);
    }

    #[test]
    fn a_whole_page_is_at_most_three_screens_from_the_top() {
        let (y, _, h, scale) = clip(&metrics(1280.0, 800.0, 5000.0, 1.0), true);
        assert_eq!((y, h), (0.0, 2400.0));
        assert!((2400.0 * scale - MAX_SIDE).abs() < 0.01);
        // A short page is captured as it is.
        let (_, _, h, _) = clip(&metrics(1280.0, 800.0, 300.0, 1.0), true);
        assert_eq!(h, 800.0);
    }

    #[test]
    fn the_stored_id_is_taken_out_of_the_text() {
        let mut result =
            json!({ "url": "https://example.com/", "screenshot_id": "a1", "width": 1 });
        assert_eq!(
            take_screenshot(&mut result),
            Some(("a1".to_string(), "https://example.com/".to_string()))
        );
        assert!(result.get(SCREENSHOT_ID_KEY).is_none());
        assert_eq!(take_screenshot(&mut json!({ "url": "x" })), None);
    }

    #[test]
    fn only_the_newest_pictures_stay() {
        let shot = |n: usize| {
            screenshot_message(
                &format!("m{n}"),
                "c",
                &[(format!("a{n}"), format!("https://site/{n}"))],
                "now",
            )
        };
        let mut messages = vec![shot(1), shot(2), shot(3)];
        fade_old_screenshots(&mut messages);
        let images = |m: &Message| {
            m.parts
                .iter()
                .filter(|p| p.kind == MessagePartKind::AttachmentReference)
                .count()
        };
        assert_eq!(images(&messages[0]), 0);
        assert!(messages[0].parts[0]
            .content
            .as_deref()
            .unwrap()
            .contains("earlier picture of https://site/1"));
        assert_eq!(images(&messages[1]), 1);
        assert_eq!(images(&messages[2]), 1);
        // Running it again changes nothing.
        let before = messages.clone();
        fade_old_screenshots(&mut messages);
        assert_eq!(
            before.iter().map(images).collect::<Vec<_>>(),
            messages.iter().map(images).collect::<Vec<_>>()
        );
    }
}
