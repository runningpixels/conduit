//! Writing: a draft's Markdown as top-level blocks with stable ids.
//!
//! The Markdown is the document; ids, owners and pins live in a sidecar so an
//! exported file stays clean. [`split`] cuts the Markdown into top-level blocks
//! (a heading, paragraph, list, quote, code block, table or other) with
//! byte offsets: the text between two blocks (blank lines) belongs to no block,
//! so the blocks and the gaps between them always concatenate back to the exact
//! input. Front matter (`---` YAML at the very top) is one `other` block, and
//! any text the parser reports no block for (link reference definitions) is
//! an `other` block too, so every visible character is in some block.
//!
//! After any change, [`reanchor`] carries ids and ownership from the old blocks
//! to the new ones: identical text first (longest common subsequence, then
//! anywhere for moved blocks), then by position among the unmatched blocks
//! between two matched neighbours. What a changed or new block becomes depends
//! on who changed it ([`EditMode`]). [`check_pinned_kept`] is the rule the model
//! works under: a pinned block (text the user wrote) must come through an AI
//! change word for word unless the call names it in `release_pinned`.

use std::ops::Range;

use provider_core::schema::{BlockOwner, DraftBlock};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag};
use serde::{Deserialize, Serialize};

pub const KIND_HEADING: &str = "heading";
pub const KIND_PARAGRAPH: &str = "paragraph";
pub const KIND_LIST: &str = "list";
pub const KIND_QUOTE: &str = "quote";
pub const KIND_CODE: &str = "code";
pub const KIND_TABLE: &str = "table";
pub const KIND_OTHER: &str = "other";

/// The Markdown dialect drafts are parsed (and exported) with.
pub fn markdown_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/// One top-level block of Markdown: its kind, heading level (0 when not a
/// heading) and byte range. The range never starts or ends with a line break.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub kind: &'static str,
    pub level: u8,
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn range(&self) -> Range<usize> {
        self.start..self.end
    }
}

/// Byte length of the front matter block at the top of `md`: a first line that
/// is exactly `---`, up to and including a later line that is `---` or `...`.
/// The returned end excludes that line's break.
pub fn front_matter_end(md: &str) -> Option<usize> {
    let first_end = md.find('\n')?;
    if md[..first_end].trim_end_matches('\r') != "---" {
        return None;
    }
    let mut pos = first_end + 1;
    while pos < md.len() {
        let line_end = md[pos..].find('\n').map_or(md.len(), |i| pos + i);
        let line = md[pos..line_end].trim_end();
        if line == "---" || line == "..." {
            return Some(pos + line.len());
        }
        pos = line_end + 1;
    }
    None
}

fn kind_of(tag: &Tag<'_>) -> (&'static str, u8) {
    match tag {
        Tag::Heading { level, .. } => (KIND_HEADING, heading_level(*level)),
        Tag::Paragraph => (KIND_PARAGRAPH, 0),
        Tag::List(_) => (KIND_LIST, 0),
        Tag::BlockQuote(_) => (KIND_QUOTE, 0),
        Tag::CodeBlock(_) => (KIND_CODE, 0),
        Tag::Table(_) => (KIND_TABLE, 0),
        _ => (KIND_OTHER, 0),
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Shrink a range so it neither starts with a line break nor ends with any
/// whitespace. Leading spaces stay: they can be part of the block's syntax.
fn tighten(md: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    let bytes = md.as_bytes();
    while start < end && matches!(bytes[start], b'\n' | b'\r') {
        start += 1;
    }
    while end > start && matches!(bytes[end - 1], b'\n' | b'\r' | b' ' | b'\t') {
        end -= 1;
    }
    (start, end)
}

/// Split Markdown into its top-level blocks, in order. See the module docs.
pub fn split(md: &str) -> Vec<Span> {
    let mut raw: Vec<Span> = Vec::new();
    let mut offset = 0;
    if let Some(end) = front_matter_end(md) {
        raw.push(Span {
            kind: KIND_OTHER,
            level: 0,
            start: 0,
            end,
        });
        offset = end;
    }
    let body = &md[offset..];
    let mut depth = 0usize;
    let mut open: Option<(&'static str, u8, usize, usize)> = None;
    for (event, range) in Parser::new_ext(body, markdown_options()).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    let (kind, level) = kind_of(&tag);
                    open = Some((kind, level, range.start, range.end));
                }
                depth += 1;
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if let Some((kind, level, start, end)) = open.take() {
                        raw.push(Span {
                            kind,
                            level,
                            start: offset + start,
                            end: offset + end.max(range.end),
                        });
                    }
                }
            }
            _ if depth == 0 => raw.push(Span {
                kind: KIND_OTHER,
                level: 0,
                start: offset + range.start,
                end: offset + range.end,
            }),
            _ => {}
        }
    }

    // Tighten, order, and fold any overlap into the earlier block.
    let mut spans: Vec<Span> = Vec::with_capacity(raw.len());
    raw.sort_by_key(|s| s.start);
    for span in raw {
        let (start, end) = tighten(md, span.start.min(md.len()), span.end.min(md.len()));
        if start >= end {
            continue;
        }
        match spans.last_mut() {
            Some(prev) if start < prev.end => prev.end = prev.end.max(end),
            _ => spans.push(Span {
                kind: span.kind,
                level: span.level,
                start,
                end,
            }),
        }
    }

    // Text the parser gave no block (link reference definitions, say) becomes
    // an `other` block, so gaps only ever hold whitespace.
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    let mut cursor = 0;
    for span in spans.into_iter().chain(std::iter::once(Span {
        kind: KIND_OTHER,
        level: 0,
        start: md.len(),
        end: md.len(),
    })) {
        let gap = &md[cursor..span.start];
        if !gap.trim().is_empty() {
            let lead = gap.len() - gap.trim_start().len();
            let (start, end) = tighten(md, cursor + lead, span.start);
            if start < end {
                out.push(Span {
                    kind: KIND_OTHER,
                    level: 0,
                    start,
                    end,
                });
            }
        }
        if span.start < span.end {
            cursor = span.end;
            out.push(span);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Words and offsets
// ---------------------------------------------------------------------------

/// Words in a piece of text: whitespace-separated runs with at least one
/// letter or digit (so list markers, `#` and table pipes don't count).
pub fn count_words(text: &str) -> u32 {
    text.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count() as u32
}

/// Words in a draft: every block except code.
pub fn word_count(md: &str) -> u32 {
    split(md)
        .iter()
        .filter(|s| s.kind != KIND_CODE)
        .map(|s| count_words(&md[s.range()]))
        .sum()
}

/// UTF-16 code-unit offsets for ascending byte offsets into `md`.
fn utf16_offsets(md: &str, sorted_bytes: &[usize]) -> Vec<u32> {
    let mut out = Vec::with_capacity(sorted_bytes.len());
    let mut units = 0u32;
    let mut chars = md.char_indices().peekable();
    for &target in sorted_bytes {
        while let Some(&(at, c)) = chars.peek() {
            if at >= target {
                break;
            }
            units += c.len_utf16() as u32;
            chars.next();
        }
        out.push(units);
    }
    out
}

// ---------------------------------------------------------------------------
// Blocks and the sidecar
// ---------------------------------------------------------------------------

/// A block's identity and ownership as stored in the sidecar (offsets and kind
/// are recomputed from the Markdown on every read).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredBlock {
    pub id: String,
    pub owner: BlockOwner,
    pub pinned: bool,
}

/// The `blocks_json` sidecar: one entry per block, in order, plus the next id
/// number so a deleted block's id is never handed out again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sidecar {
    pub next: u32,
    pub blocks: Vec<StoredBlock>,
}

impl Sidecar {
    fn fresh_id(&mut self) -> String {
        self.next = self.next.max(1);
        let id = format!("b{}", self.next);
        self.next += 1;
        id
    }

    /// Raise `next` past every id in `blocks` (after a restore, say).
    pub fn bump_past(&mut self, blocks: &[StoredBlock]) {
        for block in blocks {
            if let Some(n) = block
                .id
                .strip_prefix('b')
                .and_then(|n| n.parse::<u32>().ok())
            {
                self.next = self.next.max(n.saturating_add(1));
            }
        }
    }
}

/// A block with its byte range in the Markdown it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub id: String,
    pub kind: &'static str,
    pub level: u8,
    pub owner: BlockOwner,
    pub pinned: bool,
    pub start: usize,
    pub end: usize,
}

impl Block {
    pub fn text<'a>(&self, md: &'a str) -> &'a str {
        &md[self.start..self.end]
    }
}

/// The blocks of `md`, with ids and ownership from the sidecar. The sidecar is
/// written with the Markdown, so the counts match; if they ever don't, the
/// blocks are paired in order and any extra gets a fresh id (owner `ai`).
pub fn blocks(md: &str, sidecar: &Sidecar) -> Vec<Block> {
    let mut ids = sidecar.clone();
    split(md)
        .into_iter()
        .enumerate()
        .map(|(i, span)| {
            let stored = match sidecar.blocks.get(i) {
                Some(stored) => stored.clone(),
                None => StoredBlock {
                    id: ids.fresh_id(),
                    owner: BlockOwner::Ai,
                    pinned: false,
                },
            };
            Block {
                id: stored.id,
                kind: span.kind,
                level: span.level,
                owner: stored.owner,
                pinned: stored.pinned,
                start: span.start,
                end: span.end,
            }
        })
        .collect()
}

/// The sidecar entries for `blocks`.
pub fn stored(blocks: &[Block]) -> Vec<StoredBlock> {
    blocks
        .iter()
        .map(|b| StoredBlock {
            id: b.id.clone(),
            owner: b.owner,
            pinned: b.pinned,
        })
        .collect()
}

/// The blocks as the renderer sees them, with UTF-16 offsets into `md`.
pub fn public_blocks(md: &str, blocks: &[Block]) -> Vec<DraftBlock> {
    let mut bytes = Vec::with_capacity(blocks.len() * 2);
    for b in blocks {
        bytes.push(b.start);
        bytes.push(b.end);
    }
    let units = utf16_offsets(md, &bytes);
    blocks
        .iter()
        .enumerate()
        .map(|(i, b)| DraftBlock {
            id: b.id.clone(),
            kind: b.kind.to_string(),
            owner: b.owner,
            pinned: b.pinned,
            start: units[2 * i],
            end: units[2 * i + 1],
        })
        .collect()
}

/// Words in a draft's blocks: every block except code.
pub fn words_in(md: &str, blocks: &[Block]) -> u32 {
    blocks
        .iter()
        .filter(|b| b.kind != KIND_CODE)
        .map(|b| count_words(b.text(md)))
        .sum()
}

// ---------------------------------------------------------------------------
// Re-anchoring
// ---------------------------------------------------------------------------

/// Who made a change, which decides what changed and new blocks become.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMode {
    /// The user typed in the editor: changed blocks become theirs (`user`, or
    /// `mixed` when the model wrote them) and pinned; new blocks are `user`
    /// and pinned.
    User,
    /// The model changed the draft: changed and new blocks are `ai` and not
    /// pinned. (Pinned blocks can only change when released; see
    /// [`check_pinned_kept`].)
    Ai,
    /// A word swap the user named (`replace_in_draft`): blocks keep their owner
    /// and pin even when their text changed.
    Named,
}

fn edited_owner(owner: BlockOwner) -> BlockOwner {
    match owner {
        BlockOwner::User => BlockOwner::User,
        BlockOwner::Ai | BlockOwner::Mixed => BlockOwner::Mixed,
    }
}

/// Pairs `(old, new)` of equal items forming a longest common subsequence.
fn lcs_pairs(old: &[&str], new: &[&str]) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    // Common prefix and suffix first: most edits touch a few blocks.
    let mut head = 0;
    while head < old.len() && head < new.len() && old[head] == new[head] {
        pairs.push((head, head));
        head += 1;
    }
    let mut tail = 0;
    while tail < old.len() - head
        && tail < new.len() - head
        && old[old.len() - 1 - tail] == new[new.len() - 1 - tail]
    {
        tail += 1;
    }
    let o = &old[head..old.len() - tail];
    let n = &new[head..new.len() - tail];
    // A full table only while it stays small; past that the middle is matched
    // by identical text and position instead.
    if !o.is_empty() && !n.is_empty() && o.len().saturating_mul(n.len()) <= 4_000_000 {
        let w = n.len() + 1;
        let mut table = vec![0u32; (o.len() + 1) * w];
        for i in (0..o.len()).rev() {
            for j in (0..n.len()).rev() {
                table[i * w + j] = if o[i] == n[j] {
                    table[(i + 1) * w + j + 1] + 1
                } else {
                    table[(i + 1) * w + j].max(table[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < o.len() && j < n.len() {
            if o[i] == n[j] {
                pairs.push((head + i, head + j));
                i += 1;
                j += 1;
            } else if table[(i + 1) * w + j] >= table[i * w + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    for k in 0..tail {
        pairs.push((old.len() - tail + k, new.len() - tail + k));
    }
    pairs
}

/// Carry ids and ownership from `old` (blocks of `old_md`) to the blocks of
/// `new_md`. `sidecar.next` hands out ids for new blocks; the returned blocks
/// are in `new_md` order.
pub fn reanchor(
    old_md: &str,
    old: &[Block],
    new_md: &str,
    mode: EditMode,
    sidecar: &mut Sidecar,
) -> Vec<Block> {
    let spans = split(new_md);
    let old_text: Vec<&str> = old.iter().map(|b| b.text(old_md)).collect();
    let new_text: Vec<&str> = spans.iter().map(|s| &new_md[s.range()]).collect();

    // `(old index, same text)` for each new block.
    let mut matched: Vec<Option<(usize, bool)>> = vec![None; spans.len()];
    let mut used = vec![false; old.len()];
    for (o, n) in lcs_pairs(&old_text, &new_text) {
        matched[n] = Some((o, true));
        used[o] = true;
    }
    // Moved blocks: the same text somewhere else.
    for n in 0..spans.len() {
        if matched[n].is_some() {
            continue;
        }
        if let Some(o) = (0..old.len()).find(|&o| !used[o] && old_text[o] == new_text[n]) {
            matched[n] = Some((o, true));
            used[o] = true;
        }
    }
    // Changed blocks: by position among the unmatched blocks between two
    // matched neighbours. A piece left over from a split remembers its source.
    let mut derived: Vec<Option<usize>> = vec![None; spans.len()];
    let mut n = 0;
    while n < spans.len() {
        if matched[n].is_some() {
            n += 1;
            continue;
        }
        let run_start = n;
        while n < spans.len() && matched[n].is_none() {
            n += 1;
        }
        let lo = if run_start == 0 {
            0
        } else {
            matched[run_start - 1].map_or(0, |(o, _)| o + 1)
        };
        let hi = if n < spans.len() {
            matched[n].map_or(old.len(), |(o, _)| o)
        } else {
            old.len()
        };
        let candidates: Vec<usize> = if lo < hi {
            (lo..hi).filter(|&o| !used[o]).collect()
        } else {
            Vec::new()
        };
        for (k, at) in (run_start..n).enumerate() {
            if let Some(&o) = candidates.get(k) {
                matched[at] = Some((o, false));
                used[o] = true;
            } else if let Some(&source) = candidates.last() {
                let piece = new_text[at].trim();
                if !piece.is_empty() && old_text[source].contains(piece) {
                    derived[at] = Some(source);
                }
            }
        }
    }

    spans
        .into_iter()
        .enumerate()
        .map(|(i, span)| {
            let (id, owner, pinned) = match matched[i] {
                Some((o, true)) => (old[o].id.clone(), old[o].owner, old[o].pinned),
                Some((o, false)) => {
                    let prev = &old[o];
                    match mode {
                        EditMode::User => (prev.id.clone(), edited_owner(prev.owner), true),
                        EditMode::Ai => (prev.id.clone(), BlockOwner::Ai, false),
                        EditMode::Named => (prev.id.clone(), prev.owner, prev.pinned),
                    }
                }
                None => {
                    let source = derived[i].map(|o| &old[o]);
                    let (owner, pinned) = match (mode, source) {
                        (EditMode::User, Some(src)) => (edited_owner(src.owner), true),
                        (EditMode::User, None) => (BlockOwner::User, true),
                        (EditMode::Named, Some(src)) => (src.owner, src.pinned),
                        _ => (BlockOwner::Ai, false),
                    };
                    (sidecar.fresh_id(), owner, pinned)
                }
            };
            Block {
                id,
                kind: span.kind,
                level: span.level,
                owner,
                pinned,
                start: span.start,
                end: span.end,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The pin rule
// ---------------------------------------------------------------------------

/// The first `max` characters of `text` on one line, with an ellipsis when cut.
pub fn preview(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Every pinned block of `old` (unless its id is in `released`) must come
/// through into `new` with the same id and identical text. The error names the
/// blocks and says when the model may change them.
pub fn check_pinned_kept(
    old_md: &str,
    old: &[Block],
    new_md: &str,
    new: &[Block],
    released: &[String],
) -> Result<(), String> {
    let broken: Vec<&Block> = old
        .iter()
        .filter(|b| b.pinned && !released.iter().any(|r| r == &b.id))
        .filter(|b| {
            !new.iter()
                .any(|n| n.id == b.id && n.text(new_md) == b.text(old_md))
        })
        .collect();
    if broken.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = broken.iter().map(|b| format!("\"{}\"", b.id)).collect();
    let quoted: Vec<String> = broken
        .iter()
        .map(|b| format!("{} (\"{}\")", b.id, preview(b.text(old_md), 80)))
        .collect();
    Err(format!(
        "Nothing was changed. {} {} written by the user, so {} pinned: keep {} text exactly as it is. \
         Change a pinned block only when the user asked you to change that text, and then pass \
         release_pinned: [{}]. Otherwise leave it word for word and say in your reply that you kept it.",
        if broken.len() == 1 { "Block" } else { "Blocks" },
        quoted.join(", "),
        if broken.len() == 1 { "it is" } else { "they are" },
        if broken.len() == 1 { "its" } else { "their" },
        ids.join(", "),
    ))
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/// Trim blank lines and trailing whitespace off text going into a block.
fn clean_block_text(text: &str) -> &str {
    text.trim_start_matches(['\n', '\r']).trim_end()
}

/// Replace the text of blocks by id; an empty replacement deletes the block
/// (and the gap before it). A replacement may hold several blocks. Unknown ids
/// are an error naming them.
pub fn replace_blocks(
    md: &str,
    blocks: &[Block],
    edits: &[(String, String)],
) -> Result<String, String> {
    let unknown: Vec<&str> = edits
        .iter()
        .filter(|(id, _)| !blocks.iter().any(|b| &b.id == id))
        .map(|(id, _)| id.as_str())
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "No block {} in this draft. Call read_draft to see the block ids.",
            unknown
                .iter()
                .map(|id| format!("'{id}'"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for (i, (id, _)) in edits.iter().enumerate() {
        if edits[..i].iter().any(|(other, _)| other == id) {
            return Err(format!(
                "Block '{id}' is edited twice in this call. Edit each block once."
            ));
        }
    }
    let mut out = String::with_capacity(md.len());
    let mut cursor = 0;
    let mut wrote_block = false;
    for block in blocks {
        let replacement = edits
            .iter()
            .find(|(id, _)| id == &block.id)
            .map(|(_, text)| clean_block_text(text));
        let gap = &md[cursor..block.start];
        // A deleted block takes the gap before it along; the document's
        // leading gap always stays, and no gap is written before the first
        // block that is kept.
        let keep_gap = cursor == 0 || wrote_block;
        match replacement {
            Some("") => {
                if cursor == 0 {
                    out.push_str(gap);
                }
            }
            Some(text) => {
                if keep_gap {
                    out.push_str(gap);
                }
                out.push_str(text);
                wrote_block = true;
            }
            None => {
                if keep_gap {
                    out.push_str(gap);
                }
                out.push_str(block.text(md));
                wrote_block = true;
            }
        }
        cursor = block.end;
    }
    out.push_str(&md[cursor..]);
    if !wrote_block {
        return Ok(String::new());
    }
    Ok(out)
}

/// A heading's text without its Markdown markers, whitespace collapsed and
/// lowercased, for matching a section by name.
pub fn heading_key(text: &str) -> String {
    let first = text.lines().next().unwrap_or("");
    let stripped = first.trim().trim_start_matches('#').trim_end_matches('#');
    stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The blocks of the section whose heading (level 1 or 2) matches `heading`:
/// the heading block through the block before the next heading of the same or
/// a higher level. `None` when there is no such heading.
pub fn section_range(md: &str, blocks: &[Block], heading: &str) -> Option<Range<usize>> {
    let key = heading_key(heading);
    let first = blocks
        .iter()
        .position(|b| b.kind == KIND_HEADING && b.level <= 2 && heading_key(b.text(md)) == key)?;
    let level = blocks[first].level;
    let end = blocks[first + 1..]
        .iter()
        .position(|b| b.kind == KIND_HEADING && b.level <= level)
        .map_or(blocks.len(), |i| first + 1 + i);
    Some(first..end)
}

/// The draft with one section written: the blocks under that heading are
/// replaced, or the section is inserted where the outline puts it (before the
/// first later outline section already in the draft, else at the end).
/// `section_md` gets a `## heading` line when it does not start with a
/// heading.
pub fn write_section(
    md: &str,
    blocks: &[Block],
    outline_headings: &[String],
    heading: &str,
    section_md: &str,
) -> String {
    let body = clean_block_text(section_md);
    let starts_with_heading = split(body)
        .first()
        .is_some_and(|s| s.kind == KIND_HEADING && s.start == 0);
    let key = heading_key(heading);
    let existing = section_range(md, blocks, heading);
    // A missing heading line is the one already in the draft, else the
    // outline's wording, else the name the call gave.
    let heading_line = match &existing {
        Some(range) => blocks[range.start].text(md).to_string(),
        None => match outline_headings.iter().find(|h| heading_key(h) == key) {
            Some(h) => format!("## {}", h.trim()),
            None => format!("## {}", heading.trim()),
        },
    };
    let section = if starts_with_heading {
        body.to_string()
    } else if body.is_empty() {
        heading_line
    } else {
        format!("{heading_line}\n\n{body}")
    };

    if let Some(range) = existing {
        let start = blocks[range.start].start;
        let end = blocks[range.end - 1].end;
        return format!("{}{}{}", &md[..start], section, &md[end..]);
    }

    let position = |k: &str| outline_headings.iter().position(|h| heading_key(h) == k);
    if let Some(at) = position(&key) {
        let before = blocks.iter().find(|b| {
            b.kind == KIND_HEADING
                && b.level == 2
                && position(&heading_key(b.text(md))).is_some_and(|other| other > at)
        });
        if let Some(next) = before {
            return format!("{}{}\n\n{}", &md[..next.start], section, &md[next.start..]);
        }
    }
    if md.trim().is_empty() {
        format!("{section}\n")
    } else {
        format!("{}\n\n{}\n", md.trim_end(), section)
    }
}

/// The outline headings with no written section yet, in outline order. A
/// section is written when the draft has a `##` heading (or `#`) matching it
/// (case-insensitive, whitespace collapsed) followed by at least one
/// non-heading block before the next heading of level 1 or 2.
pub fn unwritten_sections(md: &str, outline_headings: &[String]) -> Vec<String> {
    let spans = split(md);
    let written = |heading: &str| {
        let key = heading_key(heading);
        spans
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                s.kind == KIND_HEADING && s.level <= 2 && heading_key(&md[s.range()]) == key
            })
            .any(|(i, _)| {
                spans[i + 1..]
                    .iter()
                    .take_while(|s| !(s.kind == KIND_HEADING && s.level <= 2))
                    .any(|s| s.kind != KIND_HEADING)
            })
    };
    outline_headings
        .iter()
        .filter(|h| !heading_key(h).is_empty() && !written(h))
        .map(|h| h.trim().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Blocks, gaps, offsets: the properties every split must have.
    fn assert_split_ok(md: &str) -> Vec<Span> {
        let spans = split(md);
        let mut rebuilt = String::new();
        let mut cursor = 0;
        for span in &spans {
            assert!(span.start >= cursor, "ordered: {spans:?}");
            assert!(span.start < span.end, "non-empty: {spans:?}");
            let gap = &md[cursor..span.start];
            assert!(gap.trim().is_empty(), "gap {gap:?} holds text in {md:?}");
            let text = &md[span.range()];
            assert!(
                !text.starts_with(['\n', '\r']),
                "block starts with a break: {text:?}"
            );
            assert!(
                !text.ends_with(char::is_whitespace),
                "block ends with whitespace: {text:?}"
            );
            rebuilt.push_str(gap);
            rebuilt.push_str(text);
            cursor = span.end;
        }
        assert!(md[cursor..].trim().is_empty());
        rebuilt.push_str(&md[cursor..]);
        assert_eq!(rebuilt, md, "round trip");
        spans
    }

    fn kinds(md: &str) -> Vec<&'static str> {
        assert_split_ok(md).iter().map(|s| s.kind).collect()
    }

    fn texts(md: &str) -> Vec<&str> {
        assert_split_ok(md)
            .iter()
            .map(|s| &md[s.start..s.end])
            .collect()
    }

    const SAMPLE: &str = "# Title\n\nIntro paragraph\nwith two lines.\n\n## Setup\n\n- one\n- two\n\n  continued\n- three\n\n> quoted\n> more\n\n```rust\nfn main() {\n\n    println!(\"hi\");\n}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n1. first\n2. second\n\nLast words.\n";

    #[test]
    fn splits_headings_lists_quotes_code_and_tables() {
        assert_eq!(
            kinds(SAMPLE),
            [
                KIND_HEADING,
                KIND_PARAGRAPH,
                KIND_HEADING,
                KIND_LIST,
                KIND_QUOTE,
                KIND_CODE,
                KIND_TABLE,
                KIND_OTHER,
                KIND_LIST,
                KIND_PARAGRAPH
            ]
        );
        let t = texts(SAMPLE);
        assert_eq!(t[1], "Intro paragraph\nwith two lines.");
        assert_eq!(t[3], "- one\n- two\n\n  continued\n- three");
        assert_eq!(
            t[5],
            "```rust\nfn main() {\n\n    println!(\"hi\");\n}\n```"
        );
        assert_eq!(t[6], "| a | b |\n|---|---|\n| 1 | 2 |");
        let levels: Vec<u8> = split(SAMPLE).iter().map(|s| s.level).collect();
        assert_eq!(levels[0], 1);
        assert_eq!(levels[2], 2);
    }

    #[test]
    fn fenced_code_with_blank_lines_is_one_block() {
        let md = "Before.\n\n~~~\nline one\n\n\n\nline five\n~~~\n\nAfter.";
        assert_eq!(kinds(md), [KIND_PARAGRAPH, KIND_CODE, KIND_PARAGRAPH]);
        assert_eq!(texts(md)[1], "~~~\nline one\n\n\n\nline five\n~~~");
        // An unclosed fence runs to the end of the document.
        let open = "Text.\n\n```\ncode\n\nmore code\n";
        assert_eq!(kinds(open), [KIND_PARAGRAPH, KIND_CODE]);
    }

    #[test]
    fn front_matter_is_one_other_block() {
        let md = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Hello\n\nBody.\n";
        assert_eq!(kinds(md), [KIND_OTHER, KIND_HEADING, KIND_PARAGRAPH]);
        assert_eq!(texts(md)[0], "---\ntitle: Hello\ntags: [a, b]\n---");
        // A rule at the top with no closing line is not front matter.
        let rule = "---\n\nText.";
        assert_eq!(kinds(rule), [KIND_OTHER, KIND_PARAGRAPH]);
        assert_eq!(front_matter_end(rule), None);
        // `...` closes it too.
        assert_eq!(texts("---\na: 1\n...\nBody"), ["---\na: 1\n...", "Body"]);
    }

    #[test]
    fn crlf_input_round_trips_with_breaks_in_the_gaps() {
        let md = SAMPLE.replace('\n', "\r\n");
        let lf = kinds(SAMPLE);
        assert_eq!(kinds(&md), lf);
        for text in texts(&md) {
            assert!(!text.ends_with('\r'), "{text:?}");
        }
        let fm = "---\r\ntitle: x\r\n---\r\n\r\nBody\r\n";
        assert_eq!(texts(fm), ["---\r\ntitle: x\r\n---", "Body"]);
    }

    #[test]
    fn edge_inputs_round_trip() {
        for md in [
            "",
            "\n\n\n",
            "One",
            "  indented paragraph",
            "    indented code\n\n    more\n\ntext",
            "Text\n===\n\nSub\n---\n",
            "[ref]: https://example.com\n\nSee [it][ref].",
            "<div>\nraw html\n</div>\n\nafter",
            "Footnote[^1].\n\n[^1]: The note.",
            "- [ ] task\n- [x] done",
            "> quote\nlazy continuation\n\npara",
            "Ünïcödé 🎉 text\n\n日本語の段落。",
            "trailing spaces   \n\nnext  ",
            "a\n\n\n\n\nb",
        ] {
            assert_split_ok(md);
        }
        assert_eq!(
            kinds("[ref]: https://example.com\n\nSee [it][ref]."),
            [KIND_OTHER, KIND_PARAGRAPH]
        );
        assert_eq!(
            kinds("Text\n===\n\nSub\n---\n"),
            [KIND_HEADING, KIND_HEADING]
        );
        assert!(split("\n\n\n").is_empty());
    }

    #[test]
    fn real_documents_round_trip() {
        for md in [
            include_str!("../../../../README.md"),
            include_str!("../../../../README.ja.md"),
            include_str!("../../../../CHANGELOG.md"),
            include_str!("../../../../CONTRIBUTING.md"),
        ] {
            let spans = assert_split_ok(md);
            assert!(spans.len() > 10);
            // Re-anchoring a document against itself changes nothing.
            let (old, mut sidecar) = ai_blocks(md);
            let again = reanchor(md, &old, md, EditMode::User, &mut sidecar);
            assert_eq!(again, old);
        }
    }

    #[test]
    fn words_skip_code_and_markup() {
        assert_eq!(count_words("# A heading here"), 3);
        assert_eq!(count_words("- one\n- two | three"), 3);
        assert_eq!(
            word_count("Two words.\n\n```\nlots of code words\n```\n\n- a b"),
            4
        );
    }

    #[test]
    fn utf16_offsets_count_surrogate_pairs() {
        let md = "é 🎉\n\nnext";
        let sidecar = Sidecar::default();
        let b = blocks(md, &sidecar);
        let public = public_blocks(md, &b);
        assert_eq!((public[0].start, public[0].end), (0, 4));
        assert_eq!((public[1].start, public[1].end), (6, 10));
        let utf16: Vec<u16> = md.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&utf16[public[1].start as usize..public[1].end as usize]).unwrap(),
            "next"
        );
    }

    // -- Re-anchoring -------------------------------------------------------

    fn ai_blocks(md: &str) -> (Vec<Block>, Sidecar) {
        let mut sidecar = Sidecar::default();
        let b = reanchor("", &[], md, EditMode::Ai, &mut sidecar);
        (b, sidecar)
    }

    fn ids(blocks: &[Block]) -> Vec<&str> {
        blocks.iter().map(|b| b.id.as_str()).collect()
    }

    const DOC: &str = "# T\n\nAlpha para.\n\nBeta para.\n\nGamma para.";

    #[test]
    fn new_blocks_get_sequential_ids() {
        let (b, sidecar) = ai_blocks(DOC);
        assert_eq!(ids(&b), ["b1", "b2", "b3", "b4"]);
        assert_eq!(sidecar.next, 5);
        assert!(b.iter().all(|b| b.owner == BlockOwner::Ai && !b.pinned));
    }

    #[test]
    fn a_user_edit_keeps_the_id_and_pins_the_block() {
        let (old, mut sidecar) = ai_blocks(DOC);
        let new_md = DOC.replace("Beta para.", "Beta, rewritten by me.");
        let new = reanchor(DOC, &old, &new_md, EditMode::User, &mut sidecar);
        assert_eq!(ids(&new), ["b1", "b2", "b3", "b4"]);
        assert_eq!((new[2].owner, new[2].pinned), (BlockOwner::Mixed, true));
        for i in [0, 1, 3] {
            assert_eq!(
                (new[i].owner, new[i].pinned),
                (BlockOwner::Ai, false),
                "{i}"
            );
        }
        // Editing it again keeps it mixed; a user block stays user.
        let again = reanchor(
            &new_md,
            &new,
            &new_md.replace("me.", "me!"),
            EditMode::User,
            &mut sidecar,
        );
        assert_eq!(again[2].owner, BlockOwner::Mixed);
    }

    #[test]
    fn inserted_and_deleted_blocks() {
        let (old, mut sidecar) = ai_blocks(DOC);
        let inserted = DOC.replace("Beta para.", "Beta para.\n\nA new thought.");
        let new = reanchor(DOC, &old, &inserted, EditMode::User, &mut sidecar);
        assert_eq!(ids(&new), ["b1", "b2", "b3", "b5", "b4"]);
        assert_eq!((new[3].owner, new[3].pinned), (BlockOwner::User, true));
        assert!(!new[2].pinned && !new[4].pinned);

        let deleted = inserted.replace("Alpha para.\n\n", "");
        let after = reanchor(&inserted, &new, &deleted, EditMode::User, &mut sidecar);
        assert_eq!(ids(&after), ["b1", "b3", "b5", "b4"]);
        assert!(!after[1].pinned);
        // A deleted id is never handed out again.
        let more = reanchor(
            &deleted,
            &after,
            &format!("{deleted}\n\nEnd."),
            EditMode::Ai,
            &mut sidecar,
        );
        assert_eq!(more.last().unwrap().id, "b6");
    }

    #[test]
    fn a_split_keeps_pinned_on_every_piece() {
        let md = "Intro.\n\nFirst half of it. Second half of it.\n\nOutro.";
        let (mut old, mut sidecar) = ai_blocks(md);
        old[1].pinned = true;
        old[1].owner = BlockOwner::User;
        let split_md = md.replace("of it. Second", "of it.\n\nSecond");
        let new = reanchor(md, &old, &split_md, EditMode::User, &mut sidecar);
        assert_eq!(ids(&new), ["b1", "b2", "b4", "b3"]);
        assert!(new[1].pinned && new[2].pinned);
        assert_eq!(
            (new[1].owner, new[2].owner),
            (BlockOwner::User, BlockOwner::User)
        );
        // The split of a model-written block: both pieces are mixed (the text
        // of the second piece was the model's), not a brand-new user block.
        let (old_ai, mut sidecar) = ai_blocks(md);
        let new = reanchor(md, &old_ai, &split_md, EditMode::User, &mut sidecar);
        assert_eq!(
            (new[1].owner, new[2].owner),
            (BlockOwner::Mixed, BlockOwner::Mixed)
        );
        assert!(new[1].pinned && new[2].pinned);
    }

    #[test]
    fn a_merge_keeps_the_first_id_and_pins_it() {
        let (old, mut sidecar) = ai_blocks(DOC);
        let merged = DOC.replace("Alpha para.\n\nBeta para.", "Alpha para. Beta para.");
        let new = reanchor(DOC, &old, &merged, EditMode::User, &mut sidecar);
        assert_eq!(ids(&new), ["b1", "b2", "b4"]);
        assert!(new[1].pinned);
    }

    #[test]
    fn reordered_blocks_keep_their_ids_and_state() {
        let (mut old, mut sidecar) = ai_blocks(DOC);
        old[3].pinned = true;
        let moved = "# T\n\nGamma para.\n\nAlpha para.\n\nBeta para.";
        let new = reanchor(DOC, &old, moved, EditMode::User, &mut sidecar);
        assert_eq!(ids(&new), ["b1", "b4", "b2", "b3"]);
        assert!(new[1].pinned);
        assert!(!new[2].pinned && !new[3].pinned);
    }

    #[test]
    fn ai_changes_are_ai_and_named_swaps_keep_state() {
        let (mut old, mut sidecar) = ai_blocks(DOC);
        old[2].owner = BlockOwner::User;
        old[2].pinned = true;
        let changed = DOC.replace("Beta", "Delta");
        let ai = reanchor(DOC, &old, &changed, EditMode::Ai, &mut sidecar);
        assert_eq!((ai[2].owner, ai[2].pinned), (BlockOwner::Ai, false));
        let named = reanchor(DOC, &old, &changed, EditMode::Named, &mut sidecar);
        assert_eq!((named[2].owner, named[2].pinned), (BlockOwner::User, true));
        assert_eq!(ids(&named), ids(&old));
    }

    #[test]
    fn duplicate_paragraphs_anchor_in_order() {
        let md = "Same.\n\nOther.\n\nSame.";
        let (old, mut sidecar) = ai_blocks(md);
        let new_md = "Same.\n\nOther changed.\n\nSame.";
        let new = reanchor(md, &old, new_md, EditMode::Ai, &mut sidecar);
        assert_eq!(ids(&new), ["b1", "b2", "b3"]);
    }

    // -- Pins ---------------------------------------------------------------

    #[test]
    fn pinned_blocks_must_survive_an_ai_change() {
        let (mut old, mut sidecar) = ai_blocks(DOC);
        old[2].pinned = true;
        old[2].owner = BlockOwner::User;
        let changed = DOC.replace("Beta para.", "Model rewrite.");
        let new = reanchor(DOC, &old, &changed, EditMode::Ai, &mut sidecar);
        let err = check_pinned_kept(DOC, &old, &changed, &new, &[]).unwrap_err();
        assert!(
            err.contains("b3") && err.contains("release_pinned") && err.contains("Beta para."),
            "{err}"
        );
        assert!(check_pinned_kept(DOC, &old, &changed, &new, &["b3".into()]).is_ok());

        // Changing other blocks around it is fine.
        let around = DOC.replace("Alpha para.", "Alpha, new.");
        let new = reanchor(DOC, &old, &around, EditMode::Ai, &mut sidecar);
        assert!(check_pinned_kept(DOC, &old, &around, &new, &[]).is_ok());
        assert!(new[2].pinned);

        // Deleting it is a change too.
        let gone = DOC.replace("Beta para.\n\n", "");
        let new = reanchor(DOC, &old, &gone, EditMode::Ai, &mut sidecar);
        assert!(check_pinned_kept(DOC, &old, &gone, &new, &[]).is_err());
    }

    // -- Edits ----------------------------------------------------------------

    #[test]
    fn replace_blocks_edits_deletes_and_splits() {
        let (b, _) = ai_blocks(DOC);
        let edited = replace_blocks(DOC, &b, &[("b3".into(), "Beta new.".into())]).unwrap();
        assert_eq!(edited, "# T\n\nAlpha para.\n\nBeta new.\n\nGamma para.");
        let deleted = replace_blocks(DOC, &b, &[("b3".into(), "".into())]).unwrap();
        assert_eq!(deleted, "# T\n\nAlpha para.\n\nGamma para.");
        let first_gone = replace_blocks(DOC, &b, &[("b1".into(), "".into())]).unwrap();
        assert_eq!(first_gone, "Alpha para.\n\nBeta para.\n\nGamma para.");
        let split_md =
            replace_blocks(DOC, &b, &[("b3".into(), "\nOne.\n\nTwo.\n\n".into())]).unwrap();
        assert_eq!(
            split_md,
            "# T\n\nAlpha para.\n\nOne.\n\nTwo.\n\nGamma para."
        );
        let err = replace_blocks(DOC, &b, &[("b9".into(), "x".into())]).unwrap_err();
        assert!(err.contains("'b9'") && err.contains("read_draft"), "{err}");
        assert!(replace_blocks(
            DOC,
            &b,
            &[("b2".into(), "x".into()), ("b2".into(), "y".into())]
        )
        .is_err());
        let all = b
            .iter()
            .map(|b| (b.id.clone(), String::new()))
            .collect::<Vec<_>>();
        assert_eq!(replace_blocks(DOC, &b, &all).unwrap(), "");
    }

    #[test]
    fn sections_are_found_replaced_and_inserted_in_outline_order() {
        let outline: Vec<String> = ["Intro", "Setup", "Usage"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let md = "# Guide\n\n## Intro\n\nHello.\n\n### Detail\n\nMore.\n\n## Usage\n\nUse it.";
        let (b, _) = ai_blocks(md);
        let range = section_range(md, &b, "intro").unwrap();
        assert_eq!(range, 1..5);
        assert!(section_range(md, &b, "Missing").is_none());

        let replaced = write_section(md, &b, &outline, "Intro", "Hi there.");
        assert_eq!(
            replaced,
            "# Guide\n\n## Intro\n\nHi there.\n\n## Usage\n\nUse it."
        );
        let with_heading = write_section(md, &b, &outline, "Usage", "## Usage\n\nRun it.\n");
        assert!(
            with_heading.ends_with("## Usage\n\nRun it."),
            "{with_heading}"
        );

        let inserted = write_section(md, &b, &outline, "Setup", "Install it.");
        assert_eq!(
            inserted,
            "# Guide\n\n## Intro\n\nHello.\n\n### Detail\n\nMore.\n\n## Setup\n\nInstall it.\n\n## Usage\n\nUse it."
        );
        let appended = write_section(md, &b, &outline, "Extra", "Bonus.");
        assert!(
            appended.ends_with("## Usage\n\nUse it.\n\n## Extra\n\nBonus.\n"),
            "{appended}"
        );
        assert_eq!(
            write_section("", &[], &outline, "Intro", "Hi."),
            "## Intro\n\nHi.\n"
        );
    }

    #[test]
    fn unwritten_sections_lists_outline_headings_without_content_in_order() {
        let outline: Vec<String> = ["Intro", " Setup ", "Usage", "Limits", "FAQ"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            unwritten_sections("", &outline),
            ["Intro", "Setup", "Usage", "Limits", "FAQ"]
        );
        // Intro: written. SETUP: heading only, then the next ## — unwritten.
        // Usage: only a sub-heading's content — written. Limits: a sub-heading
        // with nothing under it — unwritten. FAQ: missing.
        let md = "# Guide\n\n## intro\n\nHello.\n\n## SETUP\n\n## Usage\n\n### Detail\n\nMore.\n\n## Limits\n\n### Soon\n";
        assert_eq!(unwritten_sections(md, &outline), ["Setup", "Limits", "FAQ"]);
        // A heading repeated: any written copy counts.
        let md = "## FAQ\n\n## FAQ\n\nAnswers.";
        assert!(!unwritten_sections(md, &outline).contains(&"FAQ".to_string()));
        // `###` headings with the outline's name are not sections.
        let md = "## Other\n\n### Intro\n\nText.";
        assert!(unwritten_sections(md, &outline).contains(&"Intro".to_string()));
    }

    #[test]
    fn heading_keys_ignore_markers_and_case() {
        assert_eq!(heading_key("##  Getting   Started ##"), "getting started");
        assert_eq!(heading_key("Title\n====="), "title");
    }

    #[test]
    fn sidecar_ids_skip_past_restored_ones() {
        let mut sidecar = Sidecar {
            next: 3,
            blocks: Vec::new(),
        };
        sidecar.bump_past(&[StoredBlock {
            id: "b9".into(),
            owner: BlockOwner::Ai,
            pinned: false,
        }]);
        assert_eq!(sidecar.fresh_id(), "b10");
    }
}
