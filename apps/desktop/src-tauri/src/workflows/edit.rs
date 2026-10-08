//! What an `edit_deck` / `edit_draft` step reports: which slides or blocks
//! changed, and which pinned text the model tried to change and was refused.
//!
//! The changes come from comparing the document before and after the turn,
//! not from what the model says it did; the refusals come from the turn's
//! recorded tool calls.

use std::collections::BTreeSet;

use provider_core::schema::{DeckDetail, ToolCallRecord, ToolCallStatus};
use serde_json::{json, Value};

use crate::agent_tools::{EDIT_BLOCKS_TOOL, UPDATE_SLOTS_TOOL, WRITE_SECTION_TOOL};
use crate::db::repository::drafts::Loaded;

/// Ids of the slides that changed between `before` and `after`: new, moved,
/// restructured, reworded or given new notes, in the new order, then the ones
/// that were deleted.
pub fn changed_slides(before: &DeckDetail, after: &DeckDetail) -> Vec<String> {
    let mut changed: Vec<String> = Vec::new();
    for slide in &after.slides {
        let same = before.slides.iter().any(|old| {
            old.id == slide.id
                && old.position == slide.position
                && old.layout == slide.layout
                && old.html == slide.html
                && old.notes == slide.notes
        });
        if !same {
            changed.push(slide.id.clone());
        }
    }
    for old in &before.slides {
        if !after.slides.iter().any(|s| s.id == old.id) {
            changed.push(old.id.clone());
        }
    }
    changed
}

/// Ids of the blocks that changed between `before` and `after`: reworded,
/// pinned or unpinned, added, or removed.
pub fn changed_blocks(before: &Loaded, after: &Loaded) -> Vec<String> {
    let mut changed: Vec<String> = Vec::new();
    for block in &after.blocks {
        let same = before.blocks.iter().any(|old| {
            old.id == block.id
                && old.pinned == block.pinned
                && old.text(&before.markdown) == block.text(&after.markdown)
        });
        if !same {
            changed.push(block.id.clone());
        }
    }
    for old in &before.blocks {
        if !after.blocks.iter().any(|b| b.id == old.id) {
            changed.push(old.id.clone());
        }
    }
    changed
}

/// The headings of the sections that changed between `before` and `after`,
/// each once: those of `after` in document order, then any that were removed.
/// A block belongs to the nearest heading above it; a new section counts once,
/// however many blocks it has. Text above the first heading belongs to no
/// section.
pub fn changed_sections(before: &Loaded, after: &Loaded) -> Vec<String> {
    let changed: BTreeSet<String> = changed_blocks(before, after).into_iter().collect();
    let mut out: Vec<String> = Vec::new();
    for (doc, removed_only) in [(after, false), (before, true)] {
        let mut section: Option<String> = None;
        for block in &doc.blocks {
            if block.kind == "heading" {
                let text = block.text(&doc.markdown);
                section = Some(text.trim().trim_start_matches('#').trim().to_string());
            }
            let counts = changed.contains(&block.id)
                && (!removed_only || !after.blocks.iter().any(|b| b.id == block.id));
            if let (true, Some(heading)) = (counts, &section) {
                if !out.contains(heading) {
                    out.push(heading.clone());
                }
            }
        }
    }
    out
}

/// Pinned slots the model tried to change in a deck, from the turn's tool
/// calls: `[{ "slideId", "slot" }]`, each once.
pub fn skipped_pinned_slots(calls: &[ToolCallRecord]) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for call in calls.iter().filter(|c| c.tool_id == UPDATE_SLOTS_TOOL) {
        let skipped = call
            .result
            .as_ref()
            .and_then(|r| r["skipped_pinned"].as_array())
            .into_iter()
            .flatten();
        for entry in skipped {
            let slide = entry["slide_id"].as_str().unwrap_or_default();
            let slot = entry["slot"].as_str().unwrap_or_default();
            if seen.insert((slide.to_string(), slot.to_string())) {
                out.push(json!({ "slideId": slide, "slot": slot }));
            }
        }
    }
    out
}

/// Pinned blocks the model tried to change in a draft and was refused:
/// `[{ "blockId" }]` for each pinned block named in a refused `edit_blocks`
/// call, `[{ "heading" }]` for a refused `write_section`, each once.
pub fn skipped_pinned_blocks(calls: &[ToolCallRecord], before: &Loaded) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for call in calls
        .iter()
        .filter(|c| c.status == ToolCallStatus::Failed)
        .filter(|c| call_error(c).contains("pinned"))
    {
        let args = call.arguments.clone().unwrap_or(Value::Null);
        if call.tool_id == EDIT_BLOCKS_TOOL {
            for edit in args["edits"].as_array().into_iter().flatten() {
                let id = edit["block_id"].as_str().unwrap_or_default();
                let pinned = before.blocks.iter().any(|b| b.id == id && b.pinned);
                if pinned && seen.insert(format!("block:{id}")) {
                    out.push(json!({ "blockId": id }));
                }
            }
        } else if call.tool_id == WRITE_SECTION_TOOL {
            let heading = args["heading"].as_str().unwrap_or_default().trim();
            if !heading.is_empty() && seen.insert(format!("heading:{heading}")) {
                out.push(json!({ "heading": heading }));
            }
        }
    }
    out
}

fn call_error(call: &ToolCallRecord) -> String {
    call.error.clone().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use provider_core::schema::{DeckSlide, DeckStage};

    fn deck(slides: Vec<(&str, u32, &str)>) -> DeckDetail {
        DeckDetail {
            id: "d".into(),
            title: "T".into(),
            theme_name: "ink".into(),
            theme_css: String::new(),
            stage: DeckStage::Slides,
            storyline: Vec::new(),
            slides: slides
                .into_iter()
                .map(|(id, position, html)| DeckSlide {
                    id: id.into(),
                    position,
                    layout: "custom".into(),
                    html: html.into(),
                    notes: String::new(),
                    slots: Vec::new(),
                })
                .collect(),
            conversation_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            assumptions: String::new(),
        }
    }

    #[test]
    fn changed_slides_lists_edited_new_moved_and_deleted_ones() {
        let before = deck(vec![
            ("a", 0, "<p>1</p>"),
            ("b", 1, "<p>2</p>"),
            ("c", 2, "<p>3</p>"),
        ]);
        let after = deck(vec![
            ("b", 0, "<p>2</p>"),
            ("a", 1, "<p>1 changed</p>"),
            ("n", 2, "<p>new</p>"),
        ]);
        // b moved up, a was reworded (and moved down), n is new, c is gone.
        assert_eq!(changed_slides(&before, &after), ["b", "a", "n", "c"]);
        assert!(changed_slides(&before, &before).is_empty());
    }

    fn call(
        tool: &str,
        status: ToolCallStatus,
        args: Value,
        result: Option<Value>,
        error: Option<&str>,
    ) -> ToolCallRecord {
        ToolCallRecord {
            id: "c".into(),
            tool_id: tool.into(),
            request_id: "r".into(),
            status,
            arguments: Some(args),
            result,
            error: error.map(str::to_string),
            approved_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn skipped_pinned_slots_come_from_update_slots_results_once() {
        let skipped = json!({ "ok": true, "updated": 0, "skipped_pinned": [
            { "slide_id": "s1", "slot": "headline" }
        ]});
        let calls = vec![
            call(
                UPDATE_SLOTS_TOOL,
                ToolCallStatus::Completed,
                json!({}),
                Some(skipped.clone()),
                None,
            ),
            call(
                UPDATE_SLOTS_TOOL,
                ToolCallStatus::Completed,
                json!({}),
                Some(skipped),
                None,
            ),
        ];
        assert_eq!(
            skipped_pinned_slots(&calls),
            vec![json!({ "slideId": "s1", "slot": "headline" })]
        );
    }
}
