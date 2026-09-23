//! Text chunking for knowledge-base ingest (t1-6 M3).
//!
//! Targets ~1000 characters per chunk with ~150 characters of overlap between
//! consecutive chunks, so a fact that lands near a chunk boundary is still
//! whole in at least one chunk. Breaks are preferred at a paragraph
//! (`\n\n`) or sentence boundary (`.`/`!`/`?` followed by whitespace) found
//! near the target length; when none is nearby, it falls back to a hard cut
//! at the target.
//!
//! Everything here operates on `Vec<char>`, never on raw byte indices. A
//! byte-index split can land inside a multi-byte UTF-8 sequence and panic (or
//! worse, silently corrupt) on CJK text or emoji; character indices can't.
//! `char_start`/`char_end` are therefore **character offsets** into the
//! original text (not byte offsets) — the citation feature that reads them
//! back needs to `chars().skip(start).take(end - start)` (or equivalent), not
//! byte-slice the original string directly.

/// Target chunk length, in characters. Not a hard cap — a chunk can run
/// somewhat over when a break point is found past the target, or somewhat
/// under when one is found before it.
const TARGET_CHARS: usize = 1000;

/// Overlap between consecutive chunks, in characters.
const OVERLAP_CHARS: usize = 150;

/// How far back from the hard cutoff to look for a paragraph/sentence break.
/// Keeps a break search from wandering all the way back to the start of a
/// chunk and producing a tiny fragment.
const BREAK_SEARCH_WINDOW: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub content: String,
    /// Character offset (not byte offset) of the chunk's start in the
    /// original text.
    pub char_start: usize,
    /// Character offset (not byte offset, exclusive) of the chunk's end.
    pub char_end: usize,
}

/// Split `text` into overlapping chunks. Returns an empty `Vec` for empty
/// (or whitespace-only-after-trim... no: literally empty) input; a
/// whitespace-only input still produces one chunk, since deciding what counts
/// as "no content" is an ingest-level concern, not a chunking one.
pub fn chunk_text(text: &str) -> Vec<Chunk> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n == 0 {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;

    loop {
        let hard_end = (start + TARGET_CHARS).min(n);
        let end = if hard_end >= n {
            // Tail end of the text: take everything left, no need to hunt
            // for a break point (it's already within the target length).
            n
        } else {
            find_break_point(&chars, start, hard_end).unwrap_or(hard_end)
        };
        // A break point can't usefully land at or before `start` — guard
        // against a degenerate zero-length chunk even though the search
        // window construction below shouldn't produce one.
        let end = end.max(start + 1).min(n);

        let content: String = chars[start..end].iter().collect();
        chunks.push(Chunk {
            content,
            char_start: start,
            char_end: end,
        });

        if end >= n {
            break;
        }

        // Overlap the next chunk back by OVERLAP_CHARS, but always make
        // forward progress so a break point found very close to `start`
        // can't spin the loop in place.
        let next_start = end.saturating_sub(OVERLAP_CHARS).max(start + 1);
        start = next_start;
    }

    chunks
}

/// Look for a paragraph or sentence boundary in the window
/// `[hard_end - BREAK_SEARCH_WINDOW, hard_end)` (clamped to not cross
/// `start`), preferring the boundary closest to `hard_end`. Paragraph breaks
/// (`\n\n`) win over sentence breaks when both are present in the window,
/// since a paragraph break is the stronger semantic boundary.
fn find_break_point(chars: &[char], start: usize, hard_end: usize) -> Option<usize> {
    let lower = hard_end.saturating_sub(BREAK_SEARCH_WINDOW).max(start);
    if lower >= hard_end {
        return None;
    }

    let mut best_paragraph: Option<usize> = None;
    let mut best_sentence: Option<usize> = None;

    // Scan forward through the window so the *last* (closest to hard_end)
    // match wins for each category — `for i in lower..hard_end.saturating_sub(1)`
    // keeps `i + 1` in bounds.
    for i in lower..hard_end.saturating_sub(1) {
        let c = chars[i];
        let next = chars[i + 1];
        if c == '\n' && next == '\n' {
            best_paragraph = Some(i + 2);
        } else if (c == '.' || c == '!' || c == '?') && next.is_whitespace() {
            best_sentence = Some(i + 2);
        }
    }

    best_paragraph.or(best_sentence).map(|p| p.min(hard_end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_produces_no_chunks() {
        assert!(chunk_text("").is_empty());
    }

    #[test]
    fn short_text_is_a_single_chunk() {
        let text = "Hello, world. This is short.";
        let chunks = chunk_text(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, text);
        assert_eq!(chunks[0].char_start, 0);
        assert_eq!(chunks[0].char_end, text.chars().count());
    }

    #[test]
    fn long_text_is_split_with_overlap() {
        // Build >2 chunks worth of plain sentences.
        let sentence = "The quick brown fox jumps over the lazy dog. ";
        let text = sentence.repeat(100); // ~4700 chars
        let chunks = chunk_text(&text);
        assert!(
            chunks.len() > 2,
            "expected multiple chunks, got {}",
            chunks.len()
        );

        // char_start/char_end round-trip against the original text.
        let all_chars: Vec<char> = text.chars().collect();
        for c in &chunks {
            let rebuilt: String = all_chars[c.char_start..c.char_end].iter().collect();
            assert_eq!(rebuilt, c.content);
        }

        // Consecutive chunks overlap: the next chunk starts before the
        // previous one ends.
        for pair in chunks.windows(2) {
            assert!(
                pair[1].char_start < pair[0].char_end,
                "expected overlap between chunk {} ({}..{}) and chunk {} ({}..{})",
                0,
                pair[0].char_start,
                pair[0].char_end,
                1,
                pair[1].char_start,
                pair[1].char_end
            );
            // And it must still make forward progress.
            assert!(pair[1].char_start > pair[0].char_start);
        }

        // Every char in the original text is covered by at least one chunk.
        assert_eq!(chunks.last().unwrap().char_end, all_chars.len());
    }

    #[test]
    fn prefers_paragraph_break_near_target() {
        // Two paragraphs whose combined length is just over TARGET_CHARS,
        // with a paragraph break a little before the target.
        let para1 = "A".repeat(950);
        let para2 = "B".repeat(950);
        let text = format!("{para1}\n\n{para2}");
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2);
        // First chunk should end right at the paragraph break (after the
        // \n\n), not at a hard 1000-char cut through the B's.
        assert_eq!(chunks[0].char_end, para1.chars().count() + 2);
        assert!(chunks[0].content.ends_with("\n\n"));
    }

    #[test]
    fn falls_back_to_hard_split_with_no_nearby_boundary() {
        // No whitespace, no punctuation anywhere: nothing for the break
        // search to find, so every full-length chunk is a hard cut at
        // TARGET_CHARS.
        let text = "x".repeat(2500);
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].char_end - chunks[0].char_start, TARGET_CHARS);
    }

    #[test]
    fn handles_cjk_and_emoji_without_panicking() {
        // Mixed multi-byte content: CJK ideographs (3 bytes each in UTF-8)
        // and emoji (4-byte, some of which are themselves multi-scalar
        // grapheme clusters, e.g. a ZWJ family emoji). char-based chunking
        // must not panic here even where a byte-index split would.
        let cjk = "知識ベースはとても便利です。".repeat(200); // > 1000 chars
        let emoji = "🚀🎉👨‍👩‍👧‍👦😀🔥".repeat(100);
        let text = format!("{cjk}\n\n{emoji}");

        let chunks = chunk_text(&text);
        assert!(!chunks.is_empty());

        let all_chars: Vec<char> = text.chars().collect();
        for c in &chunks {
            // Must not panic, and must round-trip exactly against the char
            // vector (proves the offsets are character offsets, not byte
            // offsets sliced through multi-byte sequences).
            let rebuilt: String = all_chars[c.char_start..c.char_end].iter().collect();
            assert_eq!(rebuilt, c.content);
        }
        assert_eq!(chunks.last().unwrap().char_end, all_chars.len());
    }

    #[test]
    fn whitespace_only_text_is_one_chunk() {
        let chunks = chunk_text("   \n\n   ");
        assert_eq!(chunks.len(), 1);
    }
}
