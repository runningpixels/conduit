//! A small HTML tag scanner for slide pages: finds text slots (elements with
//! `data-text`), edits them, pins them (`data-owner="user"`) and does
//! text-only find and replace. Pure string work, no HTML parser dependency.

use std::ops::Range;

const VOID_ELEMENTS: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// The tags allowed inside a slot's inline content.
pub const INLINE_TAGS: [&str; 11] = [
    "span", "em", "strong", "b", "i", "u", "br", "sub", "sup", "small", "mark",
];

const OWNER_ATTR: &str = "data-owner";
const OWNER_USER: &str = "user";
const SLOT_ATTR: &str = "data-text";

fn is_void(name: &str) -> bool {
    VOID_ELEMENTS.contains(&name)
}

fn is_inline_tag(name: &str) -> bool {
    INLINE_TAGS.contains(&name)
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokKind {
    Open { name: String, self_closing: bool },
    Close { name: String },
    Comment,
}

#[derive(Debug, Clone)]
struct Tok {
    range: Range<usize>,
    kind: TokKind,
    /// The text after this tag is raw (a `<style>` body) and is not content.
    raw_after: bool,
}

/// The end (exclusive) of the tag that starts at `from` (a `<`), honouring
/// quoted attribute values. `None` when the tag never closes.
fn tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from + 1;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) => {
                if b == q {
                    quote = None;
                }
            }
            None => {
                if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'>' {
                    return Some(i + 1);
                }
            }
        }
        i += 1;
    }
    None
}

fn read_name(bytes: &[u8], from: usize) -> (String, usize) {
    let mut i = from;
    while i < bytes.len()
        && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b':' | b'_'))
    {
        i += 1;
    }
    (
        String::from_utf8_lossy(&bytes[from..i]).to_ascii_lowercase(),
        i,
    )
}

fn find_ci(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len())
        .find(|&i| haystack[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

fn scan(html: &str) -> Vec<Tok> {
    let bytes = html.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if bytes[i..].starts_with(b"<!--") {
            let end = find_ci(bytes, i + 4, b"-->").map_or(bytes.len(), |e| e + 3);
            toks.push(Tok {
                range: i..end,
                kind: TokKind::Comment,
                raw_after: false,
            });
            i = end;
            continue;
        }
        let next = bytes.get(i + 1).copied().unwrap_or(0);
        let closing = next == b'/';
        let name_from = if closing { i + 2 } else { i + 1 };
        if !bytes
            .get(name_from)
            .is_some_and(|b| b.is_ascii_alphabetic())
        {
            i += 1;
            continue;
        }
        let (name, _) = read_name(bytes, name_from);
        let Some(end) = tag_end(bytes, i) else {
            // An unterminated tag is plain text.
            i += 1;
            continue;
        };
        if closing {
            toks.push(Tok {
                range: i..end,
                kind: TokKind::Close { name },
                raw_after: false,
            });
        } else {
            let self_closing = bytes[..end - 1].last() == Some(&b'/');
            let raw = name == "style" && !self_closing;
            toks.push(Tok {
                range: i..end,
                kind: TokKind::Open { name, self_closing },
                raw_after: raw,
            });
            if raw {
                // The body is not markup: resume at its closing tag.
                i = find_ci(bytes, end, b"</style").unwrap_or(bytes.len());
                continue;
            }
        }
        i = end;
    }
    toks
}

/// The ranges of `html` that are visible text: outside tags, comments and
/// `<style>` bodies.
fn text_ranges(html: &str, toks: &[Tok]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut at = 0;
    let mut skip_raw = false;
    for tok in toks {
        if tok.range.start > at && !skip_raw {
            out.push(at..tok.range.start);
        }
        // A raw body ends at its closing tag, which is the next token.
        skip_raw = tok.raw_after;
        at = tok.range.end;
    }
    if at < html.len() && !skip_raw {
        out.push(at..html.len());
    }
    out
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Attr {
    name: String,
    value: Option<String>,
    /// The whole attribute (name through closing quote) within the tag text.
    range: Range<usize>,
}

/// The attributes of a start tag's text (`<name ...>`).
fn parse_attrs(tag: &str) -> Vec<Attr> {
    let bytes = tag.as_bytes();
    let mut i = 1;
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/'
    {
        i += 1;
    }
    let mut attrs = Vec::new();
    loop {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' {
            break;
        }
        let start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && !matches!(bytes[i], b'=' | b'>' | b'/')
        {
            i += 1;
        }
        if i == start {
            i += 1;
            continue;
        }
        let name = tag[start..i].to_ascii_lowercase();
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let mut value = None;
        let mut end = i;
        if j < bytes.len() && bytes[j] == b'=' {
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                let q = bytes[j];
                let vstart = j + 1;
                let mut k = vstart;
                while k < bytes.len() && bytes[k] != q {
                    k += 1;
                }
                value = Some(tag[vstart..k.min(bytes.len())].to_string());
                end = (k + 1).min(bytes.len());
            } else {
                let vstart = j;
                let mut k = vstart;
                while k < bytes.len() && !bytes[k].is_ascii_whitespace() && bytes[k] != b'>' {
                    k += 1;
                }
                // A trailing `/` of `<br a=b/>` is not part of the value.
                value = Some(tag[vstart..k].to_string());
                end = k;
            }
            i = end;
        }
        attrs.push(Attr {
            name,
            value,
            range: start..end,
        });
    }
    attrs
}

fn unescape_attr(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/// A slot found in a slide's HTML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSlot {
    pub index: usize,
    pub name: String,
    /// The slot's inner HTML (between its start and end tags).
    pub inner: Range<usize>,
    /// The slot's start tag.
    pub outer_open_tag: Range<usize>,
    pub pinned: bool,
    /// The element's lowercase tag name.
    pub tag: String,
    /// The element's class list.
    pub classes: Vec<String>,
    /// The whole element: start tag through end tag.
    pub outer: Range<usize>,
}

/// Every slot of `html` in document order. A slot is an element with a
/// `data-text` attribute; a slot nested inside another slot is not listed.
pub fn slots(html: &str) -> Vec<ParsedSlot> {
    let toks = scan(html);
    let mut out: Vec<ParsedSlot> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let TokKind::Open { name, self_closing } = &toks[i].kind else {
            i += 1;
            continue;
        };
        let tag = &html[toks[i].range.clone()];
        let attrs = parse_attrs(tag);
        let Some(slot_name) = attrs
            .iter()
            .find(|a| a.name == SLOT_ATTR)
            .map(|a| unescape_attr(a.value.as_deref().unwrap_or("")))
        else {
            i += 1;
            continue;
        };
        let pinned = attrs
            .iter()
            .any(|a| a.name == OWNER_ATTR && a.value.as_deref() == Some(OWNER_USER));
        let classes: Vec<String> = attrs
            .iter()
            .find(|a| a.name == "class")
            .and_then(|a| a.value.as_deref())
            .map(|v| v.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();
        let open_range = toks[i].range.clone();
        if is_void(name) || *self_closing {
            out.push(ParsedSlot {
                index: out.len(),
                name: slot_name,
                inner: open_range.end..open_range.end,
                outer: open_range.clone(),
                outer_open_tag: open_range,
                pinned,
                tag: name.clone(),
                classes,
            });
            i += 1;
            continue;
        }
        // Find the matching close by counting nested same-name tags.
        let mut depth = 1usize;
        let mut close_idx = None;
        for (j, tok) in toks.iter().enumerate().skip(i + 1) {
            match &tok.kind {
                TokKind::Open {
                    name: n,
                    self_closing: sc,
                } if n == name && !sc && !is_void(n) => depth += 1,
                TokKind::Close { name: n } if n == name => {
                    depth -= 1;
                    if depth == 0 {
                        close_idx = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close_idx) = close_idx else {
            // Never closed: not a usable slot.
            i += 1;
            continue;
        };
        out.push(ParsedSlot {
            index: out.len(),
            name: slot_name,
            inner: open_range.end..toks[close_idx].range.start,
            outer: open_range.start..toks[close_idx].range.end,
            outer_open_tag: open_range,
            pinned,
            tag: name.clone(),
            classes,
        });
        // Skip everything inside: only the outermost slot counts.
        i = close_idx + 1;
    }
    out
}

fn find_slot(html: &str, index: usize, name: &str) -> Result<ParsedSlot, String> {
    let found = slots(html).into_iter().nth(index);
    match found {
        Some(slot) if slot.name == name => Ok(slot),
        _ => Err(format!(
            "No slot \"{name}\" at position {index} on this slide. Read the slide to see its slots."
        )),
    }
}

/// Add `data-owner="user"` to the start tag at `range` (replacing another owner
/// value if there is one).
fn pin_tag(html: &mut String, range: Range<usize>) {
    let tag = html[range.clone()].to_string();
    let attrs = parse_attrs(&tag);
    let marker = format!("{OWNER_ATTR}=\"{OWNER_USER}\"");
    if let Some(attr) = attrs.iter().find(|a| a.name == OWNER_ATTR) {
        if attr.value.as_deref() == Some(OWNER_USER) {
            return;
        }
        html.replace_range(
            range.start + attr.range.start..range.start + attr.range.end,
            &marker,
        );
        return;
    }
    // Insert before the closing `>` (or `/>`).
    let mut at = range.end - 1;
    if html[..at].ends_with('/') {
        at -= 1;
    }
    let needs_space = !html[..at].ends_with(|c: char| c.is_ascii_whitespace());
    let insert = if needs_space {
        format!(" {marker}")
    } else {
        marker
    };
    html.insert_str(at, &insert);
}

fn unpin_tag(html: &mut String, range: Range<usize>) {
    let tag = html[range.clone()].to_string();
    let attrs = parse_attrs(&tag);
    let Some(attr) = attrs.iter().find(|a| a.name == OWNER_ATTR) else {
        return;
    };
    let mut start = attr.range.start;
    while start > 0 && tag.as_bytes()[start - 1].is_ascii_whitespace() {
        start -= 1;
    }
    html.replace_range(range.start + start..range.start + attr.range.end, "");
}

/// Set a slot's inner HTML (it must pass [`validate_inline`]). `pin` also marks
/// the slot as the user's; `false` leaves its marker as it was.
pub fn set_slot(
    html: &str,
    index: usize,
    name: &str,
    inner_html: &str,
    pin: bool,
) -> Result<String, String> {
    validate_inline(inner_html)?;
    let slot = find_slot(html, index, name)?;
    let mut out = html.to_string();
    // The inner range is after the start tag, so replace it first.
    out.replace_range(slot.inner.clone(), inner_html);
    if pin {
        pin_tag(&mut out, slot.outer_open_tag);
    }
    Ok(out)
}

/// Add or remove a slot's `data-owner="user"` marker.
pub fn set_pinned(html: &str, index: usize, name: &str, pinned: bool) -> Result<String, String> {
    let slot = find_slot(html, index, name)?;
    let mut out = html.to_string();
    if pinned {
        pin_tag(&mut out, slot.outer_open_tag);
    } else {
        unpin_tag(&mut out, slot.outer_open_tag);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------

/// A fresh slot name for a sibling of `name`: `stat-2` becomes the next free
/// `stat-<n>`; any other name gets `-2`, `-3`, ...
fn fresh_slot_name(name: &str, taken: &[String]) -> String {
    let (base, start) = match name.rsplit_once('-') {
        Some((base, n)) if !base.is_empty() && n.parse::<u32>().is_ok() => {
            (base.to_string(), n.parse::<u32>().unwrap_or(1) + 1)
        }
        _ => (name.to_string(), 2),
    };
    let mut k = start;
    loop {
        let candidate = format!("{base}-{k}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        k += 1;
    }
}

/// Insert an empty sibling `<li>` right after the `li` slot `(index, name)`.
/// The new element copies the start tag (attributes included) with a fresh
/// `data-text` name and no `data-owner`. Returns the new HTML and the new name.
pub fn insert_list_item_after(
    html: &str,
    index: usize,
    name: &str,
) -> Result<(String, String), String> {
    let slot = find_slot(html, index, name)?;
    if slot.tag != "li" {
        return Err("Only bullets can be added this way.".to_string());
    }
    let taken: Vec<String> = slots(html).into_iter().map(|s| s.name).collect();
    let new_name = fresh_slot_name(name, &taken);
    let mut tag = html[slot.outer_open_tag.clone()].to_string();
    let tag_len = tag.len();
    unpin_tag(&mut tag, 0..tag_len);
    if let Some(attr) = parse_attrs(&tag).iter().find(|a| a.name == SLOT_ATTR) {
        let value = format!("{SLOT_ATTR}=\"{}\"", escape_text(&new_name));
        tag.replace_range(attr.range.clone(), &value);
    }
    let mut out = html.to_string();
    out.insert_str(slot.outer.end, &format!("{tag}</li>"));
    Ok((out, new_name))
}

/// Remove the whole element of the `li` slot `(index, name)`, provided its list
/// keeps at least one other `li`.
pub fn remove_slot_element(html: &str, index: usize, name: &str) -> Result<String, String> {
    let slot = find_slot(html, index, name)?;
    if slot.tag != "li" {
        return Err("Only bullets can be removed this way.".to_string());
    }
    let toks = scan(html);
    // The innermost ul/ol around the slot.
    let mut stack: Vec<usize> = Vec::new();
    for (i, tok) in toks.iter().enumerate() {
        if tok.range.start >= slot.outer.start {
            break;
        }
        match &tok.kind {
            TokKind::Open { name, self_closing } if !self_closing && !is_void(name) => {
                stack.push(i);
            }
            TokKind::Close { name } => {
                if let Some(pos) = stack.iter().rposition(
                    |&j| matches!(&toks[j].kind, TokKind::Open { name: n, .. } if n == name),
                ) {
                    stack.truncate(pos);
                }
            }
            _ => {}
        }
    }
    let list_open = stack
        .iter()
        .rev()
        .find(|&&j| matches!(&toks[j].kind, TokKind::Open { name, .. } if name == "ul" || name == "ol"))
        .copied();
    let scope = match list_open {
        Some(open) => {
            let TokKind::Open {
                name: list_name, ..
            } = &toks[open].kind
            else {
                unreachable!()
            };
            let mut depth = 1usize;
            let mut end = html.len();
            for tok in toks.iter().skip(open + 1) {
                match &tok.kind {
                    TokKind::Open { name, self_closing } if name == list_name && !self_closing => {
                        depth += 1;
                    }
                    TokKind::Close { name } if name == list_name => {
                        depth -= 1;
                        if depth == 0 {
                            end = tok.range.start;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            toks[open].range.end..end
        }
        None => 0..html.len(),
    };
    let others = toks
        .iter()
        .filter(|t| {
            t.range.start >= scope.start
                && t.range.end <= scope.end
                && t.range.start != slot.outer.start
                && matches!(&t.kind, TokKind::Open { name, .. } if name == "li")
        })
        .count();
    if others == 0 {
        return Err(
            "A list needs at least one bullet, so the last one can't be removed.".to_string(),
        );
    }
    let mut out = html.to_string();
    out.replace_range(slot.outer.clone(), "");
    Ok(out)
}

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

/// Check that `inner` holds only text and the inline tags (`span em strong b i
/// u br sub sup small mark`), with no attributes except `class`.
pub fn validate_inline(inner: &str) -> Result<(), String> {
    let allowed = || INLINE_TAGS.join(", ");
    for tok in scan(inner) {
        match &tok.kind {
            TokKind::Comment => return Err("Slot text can't contain comments.".to_string()),
            TokKind::Close { name } | TokKind::Open { name, .. } => {
                if !is_inline_tag(name) {
                    return Err(format!(
                        "Slot text can only use these tags: {}. Found <{name}>.",
                        allowed()
                    ));
                }
                if let TokKind::Open { .. } = &tok.kind {
                    let tag = &inner[tok.range.clone()];
                    if let Some(attr) = parse_attrs(tag).iter().find(|a| a.name != "class") {
                        return Err(format!(
                            "Slot text tags can only have a class attribute. Found {} on <{name}>.",
                            attr.name
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

/// Escape `& < > "` for use as HTML text.
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Entity ranges (`&amp;`, `&#39;`) in a text segment.
fn entity_ranges(seg: &str) -> Vec<Range<usize>> {
    let bytes = seg.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'#') {
                j += 1;
            }
            if j > i + 1 && j < bytes.len() && bytes[j] == b';' && j - i <= 10 {
                out.push(i..j + 1);
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn chars_match(a: char, b: char, match_case: bool) -> bool {
    a == b || (!match_case && a.to_lowercase().eq(b.to_lowercase()))
}

/// Replace `find` in one text segment. `entities` guards `&...;` sequences from
/// being matched into.
fn replace_in_segment(
    seg: &str,
    find: &[char],
    replace: &str,
    match_case: bool,
    whole_word: bool,
    entities: bool,
) -> (String, u32) {
    let chars: Vec<(usize, char)> = seg.char_indices().collect();
    let ents = if entities {
        entity_ranges(seg)
    } else {
        Vec::new()
    };
    let strictly_inside = |pos: usize| ents.iter().any(|r| pos > r.start && pos < r.end);
    let mut out = String::with_capacity(seg.len());
    let mut count = 0u32;
    let mut ci = 0;
    while ci < chars.len() {
        let matched = ci + find.len() <= chars.len()
            && find
                .iter()
                .enumerate()
                .all(|(k, f)| chars_match(chars[ci + k].1, *f, match_case));
        if matched {
            let start = chars[ci].0;
            let end = chars.get(ci + find.len()).map_or(seg.len(), |(p, _)| *p);
            let mut ok = !strictly_inside(start) && !strictly_inside(end);
            if ok && whole_word {
                let before = seg[..start].chars().next_back();
                let after = seg[end..].chars().next();
                ok = !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char);
            }
            if ok {
                out.push_str(replace);
                count += 1;
                ci += find.len();
                continue;
            }
        }
        out.push(chars[ci].1);
        ci += 1;
    }
    (out, count)
}

/// Replace `find` with `replace` in the visible text of `html` only (never in
/// tags, attributes, comments or `<style>`). Both strings are HTML-escaped
/// first, so `R&D` matches `R&amp;D`. Returns the new HTML and the match count.
pub fn replace_text(
    html: &str,
    find: &str,
    replace: &str,
    match_case: bool,
    whole_word: bool,
) -> (String, u32) {
    if find.is_empty() {
        return (html.to_string(), 0);
    }
    let find_chars: Vec<char> = escape_text(find).chars().collect();
    let replace = escape_text(replace);
    let toks = scan(html);
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    let mut total = 0;
    for range in text_ranges(html, &toks) {
        out.push_str(&html[at..range.start]);
        let (text, n) = replace_in_segment(
            &html[range.clone()],
            &find_chars,
            &replace,
            match_case,
            whole_word,
            true,
        );
        out.push_str(&text);
        total += n;
        at = range.end;
    }
    out.push_str(&html[at..]);
    (out, total)
}

/// The same replace for plain text (speaker notes): no escaping, no markup.
pub fn replace_plain(
    text: &str,
    find: &str,
    replace: &str,
    match_case: bool,
    whole_word: bool,
) -> (String, u32) {
    if find.is_empty() {
        return (text.to_string(), 0);
    }
    let find_chars: Vec<char> = find.chars().collect();
    replace_in_segment(text, &find_chars, replace, match_case, whole_word, false)
}

// ---------------------------------------------------------------------------
// Pinned slots
// ---------------------------------------------------------------------------

/// Check that every pinned slot of `old` (except those named in `released`)
/// survives into `new` with identical inner HTML, matched by name and
/// occurrence among same-named slots. A kept slot that lost its marker gets it
/// back; the fixed HTML is returned.
pub fn check_pinned_kept(old: &str, new: &str, released: &[String]) -> Result<String, String> {
    let old_slots = slots(old);
    let new_slots = slots(new);
    let mut re_pin: Vec<Range<usize>> = Vec::new();
    for (pos, slot) in old_slots.iter().enumerate() {
        if !slot.pinned || released.iter().any(|r| r == &slot.name) {
            continue;
        }
        let occurrence = old_slots[..pos]
            .iter()
            .filter(|s| s.name == slot.name)
            .count();
        let counterpart = new_slots
            .iter()
            .filter(|s| s.name == slot.name)
            .nth(occurrence);
        match counterpart {
            Some(c) if new[c.inner.clone()] == old[slot.inner.clone()] => {
                if !c.pinned {
                    re_pin.push(c.outer_open_tag.clone());
                }
            }
            _ => {
                return Err(format!(
                    "Slot \"{name}\" on this slide was written by the user, so it is pinned. \
                     Keep its content exactly, or pass release_pinned: [\"{name}\"] only if the user asked you to change it.",
                    name = slot.name
                ));
            }
        }
    }
    let mut fixed = new.to_string();
    // Later tags first so earlier offsets stay valid.
    re_pin.sort_by_key(|r| std::cmp::Reverse(r.start));
    for range in re_pin {
        pin_tag(&mut fixed, range);
    }
    Ok(fixed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(html: &str) -> Vec<String> {
        slots(html).into_iter().map(|s| s.name).collect()
    }

    #[test]
    fn finds_slots_in_order_with_ranges() {
        let html = r#"<h1 data-text="title">Hi</h1><p data-text='sub' class="x">There</p>"#;
        let found = slots(html);
        assert_eq!(names(html), ["title", "sub"]);
        assert_eq!(&html[found[0].inner.clone()], "Hi");
        assert_eq!(&html[found[1].inner.clone()], "There");
        assert_eq!(found[1].index, 1);
        assert!(!found[0].pinned);
    }

    #[test]
    fn nested_same_name_tags_close_correctly() {
        let html = r#"<div data-text="a"><div>inner</div> tail</div><div data-text="b">x</div>"#;
        let found = slots(html);
        assert_eq!(&html[found[0].inner.clone()], "<div>inner</div> tail");
        assert_eq!(&html[found[1].inner.clone()], "x");
    }

    #[test]
    fn only_the_outermost_slot_counts() {
        let html = r#"<div data-text="outer"><span data-text="inner">x</span></div>"#;
        assert_eq!(names(html), ["outer"]);
    }

    #[test]
    fn void_elements_and_self_closing_do_not_swallow_siblings() {
        let html = r#"<img data-text="pic" src="a.png"><p data-text="after">t</p><br>"#;
        let found = slots(html);
        assert_eq!(names(html), ["pic", "after"]);
        assert_eq!(found[0].inner.start, found[0].inner.end);
        // A <br> inside a slot does not break the nesting count.
        let html = r#"<p data-text="a">one<br>two</p>"#;
        assert_eq!(&html[slots(html)[0].inner.clone()], "one<br>two");
    }

    #[test]
    fn style_blocks_and_comments_are_skipped() {
        let html = r#"<style>.x::before{content:"<p data-text='fake'>"}</style><!-- <p data-text="ghost">no</p> --><p data-text="real">yes</p>"#;
        assert_eq!(names(html), ["real"]);
    }

    #[test]
    fn quoted_gt_in_attributes_is_handled() {
        let html = r#"<p title="a>b" data-text="x">ok</p>"#;
        let found = slots(html);
        assert_eq!(&html[found[0].inner.clone()], "ok");
    }

    #[test]
    fn duplicate_names_are_addressed_by_index() {
        let html = r#"<p data-text="line">a</p><p data-text="line">b</p>"#;
        let out = set_slot(html, 1, "line", "B", false).unwrap();
        assert_eq!(out, r#"<p data-text="line">a</p><p data-text="line">B</p>"#);
        assert!(set_slot(html, 1, "other", "B", false).is_err());
        assert!(set_slot(html, 5, "line", "B", false).is_err());
    }

    #[test]
    fn set_slot_pins_and_keeps_other_attributes() {
        let html = r#"<h1 class="big" data-text="title">Old</h1>"#;
        let out = set_slot(html, 0, "title", "New <em>one</em>", true).unwrap();
        assert_eq!(
            out,
            r#"<h1 class="big" data-text="title" data-owner="user">New <em>one</em></h1>"#
        );
        assert!(slots(&out)[0].pinned);
        // Pinning twice does not add a second marker.
        let again = set_slot(&out, 0, "title", "Newer", true).unwrap();
        assert_eq!(again.matches("data-owner").count(), 1);
    }

    #[test]
    fn set_pinned_adds_and_removes_the_marker() {
        let html = r#"<p data-text="a" class="x">t</p>"#;
        let pinned = set_pinned(html, 0, "a", true).unwrap();
        assert_eq!(
            pinned,
            r#"<p data-text="a" class="x" data-owner="user">t</p>"#
        );
        let unpinned = set_pinned(&pinned, 0, "a", false).unwrap();
        assert_eq!(unpinned, html);
        // Unpinning an unpinned slot is a no-op.
        assert_eq!(set_pinned(html, 0, "a", false).unwrap(), html);
        // A void slot with a trailing slash.
        let void = r#"<img data-text="p" />"#;
        let out = set_pinned(void, 0, "p", true).unwrap();
        assert!(out.contains(r#"data-owner="user""#), "{out}");
        assert!(slots(&out)[0].pinned);
    }

    #[test]
    fn inline_allowlist() {
        assert!(validate_inline("plain & text, a < b").is_ok());
        assert!(
            validate_inline(r#"A <strong class="k">bold</strong> <br/> <mark>m</mark>"#).is_ok()
        );
        let err = validate_inline("<div>x</div>").unwrap_err();
        assert!(err.contains("<div>"), "{err}");
        assert!(validate_inline(r#"<span style="color:red">x</span>"#).is_err());
        assert!(validate_inline(r#"<span onclick="x()">x</span>"#).is_err());
        assert!(validate_inline("<script>x</script>").is_err());
        assert!(validate_inline("<!-- note -->").is_err());
        assert!(set_slot(r#"<p data-text="a">t</p>"#, 0, "a", "<div>x</div>", false).is_err());
    }

    #[test]
    fn replace_touches_text_only() {
        let html = r#"<style>.cat{color:red}</style><p class="cat" title="cat" data-text="a">A cat sat</p><!-- cat -->"#;
        let (out, n) = replace_text(html, "cat", "dog", true, false);
        assert_eq!(n, 1);
        assert_eq!(
            out,
            r#"<style>.cat{color:red}</style><p class="cat" title="cat" data-text="a">A dog sat</p><!-- cat -->"#
        );
    }

    #[test]
    fn replace_is_entity_aware() {
        let (out, n) = replace_text("<p>Our R&amp;D team</p>", "R&D", "Research", true, false);
        assert_eq!((out.as_str(), n), ("<p>Our Research team</p>", 1));
        let (out, n) = replace_text("<p>a</p>", "a", "R&D <x>", true, false);
        assert_eq!((out.as_str(), n), ("<p>R&amp;D &lt;x&gt;</p>", 1));
        // The letters of an entity are not text.
        let (out, n) = replace_text("<p>x &amp; y</p>", "amp", "Z", true, false);
        assert_eq!((out.as_str(), n), ("<p>x &amp; y</p>", 0));
        let (out, n) = replace_text("<p>x &amp; y</p>", "&", "and", true, false);
        assert_eq!((out.as_str(), n), ("<p>x and y</p>", 1));
    }

    #[test]
    fn replace_case_and_whole_word() {
        let html = "<p>Cat cat concat cats</p>";
        assert_eq!(replace_text(html, "cat", "dog", false, false).1, 4);
        assert_eq!(replace_text(html, "cat", "dog", true, false).1, 3);
        let (out, n) = replace_text(html, "cat", "dog", false, true);
        assert_eq!((out.as_str(), n), ("<p>dog dog concat cats</p>", 2));
        let (_, n) = replace_text("<p>a_cat cat1 cat.</p>", "cat", "x", true, true);
        assert_eq!(n, 1);
        assert_eq!(replace_text(html, "", "x", true, false).1, 0);
    }

    #[test]
    fn replace_plain_for_notes() {
        let (out, n) = replace_plain("Say R&D twice, R&D!", "R&D", "Research", true, true);
        assert_eq!((out.as_str(), n), ("Say Research twice, Research!", 2));
    }

    #[test]
    fn pinned_check_accepts_kept_and_rejects_changed() {
        let old = r#"<h1 data-text="t">Title</h1><p data-text="s" data-owner="user">Mine</p>"#;
        let kept = r#"<h1 data-text="t">New title</h1><p data-text="s" data-owner="user">Mine</p>"#;
        assert_eq!(check_pinned_kept(old, kept, &[]).unwrap(), kept);

        let changed =
            r#"<h1 data-text="t">Title</h1><p data-text="s" data-owner="user">Theirs</p>"#;
        let err = check_pinned_kept(old, changed, &[]).unwrap_err();
        assert!(
            err.contains(r#"Slot "s""#) && err.contains("release_pinned"),
            "{err}"
        );
        assert!(check_pinned_kept(old, changed, &["s".to_string()]).is_ok());

        let removed = r#"<h1 data-text="t">Title</h1>"#;
        assert!(check_pinned_kept(old, removed, &[]).is_err());
    }

    #[test]
    fn slots_report_tag_and_classes() {
        let html = r#"<h1 class="headline  big" data-text="t">x</h1><li data-text="b">y</li>"#;
        let found = slots(html);
        assert_eq!(found[0].tag, "h1");
        assert_eq!(found[0].classes, ["headline", "big"]);
        assert_eq!(found[1].tag, "li");
        assert!(found[1].classes.is_empty());
        assert_eq!(&html[found[1].outer.clone()], r#"<li data-text="b">y</li>"#);
    }

    #[test]
    fn insert_bullet_copies_the_tag_with_a_fresh_name() {
        let html = r#"<ul><li class="b" data-text="point-1" data-owner="user">One</li><li data-text="point-2">Two</li></ul>"#;
        let (out, name) = insert_list_item_after(html, 0, "point-1").unwrap();
        assert_eq!(name, "point-3");
        assert_eq!(
            out,
            r#"<ul><li class="b" data-text="point-1" data-owner="user">One</li><li class="b" data-text="point-3"></li><li data-text="point-2">Two</li></ul>"#
        );
        let found = slots(&out);
        assert_eq!(found[1].name, "point-3");
        assert!(!found[1].pinned);

        let (out, name) =
            insert_list_item_after(r#"<ul><li data-text="item">a</li></ul>"#, 0, "item").unwrap();
        assert_eq!(name, "item-2");
        let (_, name) = insert_list_item_after(&out, 0, "item").unwrap();
        assert_eq!(name, "item-3");
    }

    #[test]
    fn insert_bullet_rejects_non_list_items() {
        let err = insert_list_item_after(r#"<p data-text="a">x</p>"#, 0, "a").unwrap_err();
        assert_eq!(err, "Only bullets can be added this way.");
        assert!(insert_list_item_after(r#"<li data-text="a">x</li>"#, 1, "a").is_err());
    }

    #[test]
    fn remove_bullet_needs_another_item_in_the_list() {
        let html = r#"<ul><li data-text="a">1</li><li data-text="b">2</li></ul>"#;
        assert_eq!(
            remove_slot_element(html, 1, "b").unwrap(),
            r#"<ul><li data-text="a">1</li></ul>"#
        );
        let one = r#"<ul><li data-text="a">1</li></ul><ul><li data-text="z">9</li></ul>"#;
        assert!(remove_slot_element(one, 0, "a").is_err());
        assert!(remove_slot_element(r#"<p data-text="a">x</p>"#, 0, "a").is_err());
    }

    #[test]
    fn pinned_check_re_adds_a_dropped_marker() {
        let old = r#"<p data-text="s" data-owner="user">Mine</p><p data-text="s" data-owner="user">Also</p>"#;
        let dropped =
            r#"<section><p data-text="s">Mine</p><p class="k" data-text="s">Also</p></section>"#;
        let fixed = check_pinned_kept(old, dropped, &[]).unwrap();
        assert_eq!(
            fixed,
            r#"<section><p data-text="s" data-owner="user">Mine</p><p class="k" data-text="s" data-owner="user">Also</p></section>"#
        );
        // Occurrence-based: the second pinned occurrence must keep its content.
        let swapped = r#"<p data-text="s" data-owner="user">Also</p><p data-text="s" data-owner="user">Mine</p>"#;
        assert!(check_pinned_kept(old, swapped, &[]).is_err());
    }
}
