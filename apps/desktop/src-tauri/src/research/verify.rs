//! The quote check: a claim counts only if its quote is really in the page.
//!
//! Done by code, never by a model. Both sides are normalised first so a
//! faithful quote isn't lost to typography: whitespace runs (including
//! non-breaking spaces) become one space, curly quotes and apostrophes become
//! straight ones, every kind of dash becomes `-`, and case is ignored.
//! A quote shorter than [`MIN_QUOTE_CHARS`] after that proves nothing ("in
//! 2024" is on half the web) and never verifies.

/// Shortest quote, after normalising, that can verify a claim.
pub const MIN_QUOTE_CHARS: usize = 20;

/// `text` with whitespace collapsed, quotes straightened, dashes unified and
/// letters lowercased.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        let mapped = match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' | '\u{00B4}'
            | '\u{0060}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' | '\u{00AB}'
            | '\u{00BB}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' | '\u{FE58}' | '\u{FE63}' | '\u{FF0D}' => '-',
            '\u{2026}' => {
                // An ellipsis character reads as three dots.
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push_str("...");
                continue;
            }
            other => other,
        };
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.extend(mapped.to_lowercase());
    }
    out
}

/// The quote as a model gave it, without the quotation marks it may have
/// wrapped it in.
fn unwrap_quote(quote: &str) -> &str {
    let wrappers: &[char] = &[
        '"', '\'', '\u{201C}', '\u{201D}', '\u{2018}', '\u{2019}', '\u{00AB}', '\u{00BB}',
    ];
    quote.trim().trim_matches(wrappers).trim()
}

/// Normalised `quote`, if it is long enough to count.
pub fn usable_quote(quote: &str) -> Option<String> {
    let normalized = normalize(unwrap_quote(quote));
    (normalized.chars().count() >= MIN_QUOTE_CHARS).then_some(normalized)
}

/// `true` when `quote` (long enough to count) occurs in `source_text`, both
/// normalised. `normalized_source` is `normalize(source_text)`, computed once
/// per page by the caller.
pub fn quote_in_normalized(quote: &str, normalized_source: &str) -> bool {
    usable_quote(quote).is_some_and(|q| normalized_source.contains(&q))
}

/// [`quote_in_normalized`] for a one-off check.
pub fn quote_found(quote: &str, source_text: &str) -> bool {
    quote_in_normalized(quote, &normalize(source_text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "The city\u{00A0}council voted   7\u{2013}2 on \u{201C}Tuesday\u{201D}\n\
        to approve the plan. It\u{2019}s the first such vote since 2019.";

    #[test]
    fn whitespace_curly_quotes_dashes_and_case_are_normalised() {
        assert!(quote_found(
            "the city council voted 7-2 on \"Tuesday\"",
            PAGE
        ));
        assert!(quote_found("It's the first such vote since 2019.", PAGE));
        assert!(quote_found("THE CITY COUNCIL\nVOTED 7—2", PAGE));
    }

    #[test]
    fn a_quote_wrapped_in_quotation_marks_still_matches() {
        assert!(quote_found(
            "\u{201C}to approve the plan. It's the first\u{201D}",
            PAGE
        ));
    }

    #[test]
    fn a_quote_not_in_the_page_fails() {
        assert!(!quote_found("the city council voted 9-0 on Tuesday", PAGE));
    }

    #[test]
    fn short_quotes_never_count() {
        // In the page, but under 20 characters.
        assert!(!quote_found("since 2019", PAGE));
        assert!(!quote_found("", PAGE));
        assert!(usable_quote("exactly twenty chars").is_some());
        assert!(usable_quote("nineteen characters").is_none());
    }

    #[test]
    fn normalize_collapses_and_trims() {
        assert_eq!(normalize("  A\t\tB \u{2026} C  "), "a b ... c");
    }
}
