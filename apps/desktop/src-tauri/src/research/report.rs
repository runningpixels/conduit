//! The report: the writer call, then everything that makes it trustworthy,
//! done by code.
//!
//! The writer sees the brief and the verified claims, each labelled `C<n>`
//! with its host and the extractor's rating of that host's page — never page
//! text — and cites by label. A review call then checks the draft's
//! sentences against the claims they cite and returns exact-text fixes,
//! which code applies only where they match once and cite real labels. Code
//! then turns
//! labels into plain `[k]` citations numbered by source in first-cited order,
//! drops labels that name no verified claim (and any citation or footnote the
//! writer typed itself), and renders the numbered Sources list from the
//! stored sources.
//!
//! The Markdown keeps to what the app's own renderer draws (headings, lists,
//! `*italic*`, `**bold**`, links, blockquotes): no footnote syntax, no
//! `_underscore_` italics, no tables.
//! A sentence can therefore only point at a page the run read and whose
//! quote it found.

use std::collections::{HashMap, HashSet};

use provider_core::schema::{ResearchBrief, ResearchDepth, ResearchSourceStatus};
use regex::Regex;
use serde_json::{json, Value};

use super::claims::{Credibility, SourceRating};
use super::run::{ClaimRecord, SourceRecord};
use super::{ask_json, clip, one_line, ResearchIo};

/// Most claims shown to the writer, spread across the sub-questions.
pub const MAX_WRITER_CLAIMS: usize = 60;
/// Most uncited pages listed under Sources.
const MAX_OTHER_PAGES: usize = 50;
/// Most fixes taken from one review.
pub const MAX_REVIEW_FIXES: usize = 20;
/// Most unreadable sites named after an open question.
const MAX_UNREADABLE_HOSTS: usize = 4;

const WRITER_SYSTEM: &str = "You write research reports from verified facts only. You do not \
browse or use tools. Reply with JSON only.";

fn writer_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string" },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "subQuestion": { "type": "integer", "minimum": 1 },
                        "text": { "type": "string" }
                    },
                    "required": ["subQuestion", "text"]
                }
            },
            "disagreements": { "type": ["string", "null"] }
        },
        "required": ["summary", "findings"]
    })
}

/// A verified claim as the writer sees it: label `C<label>`.
#[derive(Debug, Clone)]
pub struct Labelled<'a> {
    pub label: usize,
    pub claim: &'a ClaimRecord,
    pub source: &'a SourceRecord,
}

/// Label up to [`MAX_WRITER_CLAIMS`] verified claims, taking them in turn
/// from each sub-question so none crowds out the rest. Within a
/// sub-question, claims from more credible pages come first, so the cap
/// drops low-credibility ones first and the writer (and the fallback) meets
/// the credible ones first.
pub fn label_claims<'a>(
    claims: &'a [ClaimRecord],
    sources: &'a [SourceRecord],
    sub_questions: usize,
) -> Vec<Labelled<'a>> {
    let by_id: HashMap<&str, &SourceRecord> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let credibility = |claim: &ClaimRecord| {
        by_id
            .get(claim.source_id.as_str())
            .map(|s| s.rating.credibility)
            .unwrap_or_default()
    };
    let mut queues: Vec<Vec<&ClaimRecord>> = vec![Vec::new(); sub_questions.max(1)];
    for claim in claims.iter().filter(|c| c.verified) {
        if let Some(queue) = queues.get_mut(claim.sub_question) {
            queue.push(claim);
        }
    }
    for queue in &mut queues {
        // Stable: extraction order breaks ties.
        queue.sort_by_key(|c| credibility(c));
    }
    let mut picked: Vec<&ClaimRecord> = Vec::new();
    let mut depth = 0;
    while picked.len() < MAX_WRITER_CLAIMS && queues.iter().any(|q| q.len() > depth) {
        for queue in &queues {
            if let Some(claim) = queue.get(depth) {
                if picked.len() < MAX_WRITER_CLAIMS {
                    picked.push(claim);
                }
            }
        }
        depth += 1;
    }
    // Labels follow credibility, then extraction order (and with it, page order).
    let order: HashMap<&str, usize> = claims
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.as_str(), i))
        .collect();
    picked.sort_by_key(|c| {
        (
            credibility(c),
            order.get(c.id.as_str()).copied().unwrap_or(usize::MAX),
        )
    });
    picked
        .into_iter()
        .filter_map(|claim| {
            by_id
                .get(claim.source_id.as_str())
                .map(|source| (claim, *source))
        })
        .enumerate()
        .map(|(i, (claim, source))| Labelled {
            label: i + 1,
            claim,
            source,
        })
        .collect()
}

/// What the writer (or the fallback) wrote, with `[C<n>]` labels still in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Draft {
    pub summary: String,
    /// Text per sub-question (0-based index); missing ones get the fallback.
    pub findings: HashMap<usize, String>,
    pub disagreements: Option<String>,
}

/// `example.com · low: unreviewed archive` — a page's host and rating, the
/// reason only for a low one (the one the writer must handle differently).
fn rated_host(source: &SourceRecord) -> String {
    let rating = &source.rating;
    match (rating.credibility, rating.reason.is_empty()) {
        (Credibility::Low, false) => format!("{} · low: {}", source.host, rating.reason),
        (credibility, _) => format!("{} · {}", source.host, credibility.as_str()),
    }
}

/// The claims as the writer and the reviewer see them, one per line.
fn fact_lines(claims: &[Labelled<'_>]) -> String {
    claims
        .iter()
        .map(|c| {
            format!(
                "[C{}] (sub-question {}; {}) {} Quote: \"{}\"",
                c.label,
                c.claim.sub_question + 1,
                rated_host(c.source),
                c.claim.claim,
                clip(&one_line(&c.claim.quote), 200)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn numbered(sub_questions: &[String]) -> String {
    sub_questions
        .iter()
        .enumerate()
        .map(|(i, q)| format!("{}. {q}", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

fn writer_prompt(brief: &ResearchBrief, claims: &[Labelled<'_>], today: &str) -> String {
    let scope = brief
        .scope
        .as_deref()
        .map(|s| format!("Scope: {s}\n"))
        .unwrap_or_default();
    format!(
        "Today is {today}.\nQuestion: {question}\n{scope}Sub-questions:\n{subs}\n\n\
Facts, each checked against its page, with the page's site and credibility:\n{facts}\n\n\
Write the report from these facts only.\n\
summary: 5 to 8 sentences that answer the question. End every sentence with the ids of the \
facts it rests on, like [C2] or [C1, C4].\n\
findings: for each sub-question that has facts, a short paragraph or at most 6 \"- \" bullets, \
ids after every sentence, using only facts that answer that sub-question. Merge facts that say \
the same thing into one sentence with all their ids. Leave out sub-questions \
with no facts (they are listed separately); never write that something was not found.\n\
disagreements: only facts that really conflict, both sides with their ids; else null. Figures \
that differ by date, edition or version, by definition (effective vs nominal rate), by units or \
by scope do not conflict: say which where you report them. Drop a figure that is implausible \
next to the others. Never repeat a finding here.\n\
Time: anything before {today} is past; give \"as of\" a fact's date when a figure may have \
changed since.\n\
Low credibility: never state such a fact as established; attribute it (\"an unreviewed \
preprint claims …\") or leave it out. The summary must not rest on low-credibility facts alone.\n\
A figure a site computed itself is \"calculated by\" that site, not \"published\". State each \
point once, as the fact itself (never \"the page\" or \"the source\"). Never invent facts, \
numbers or ids. No title, headings, links or source list.",
        question = brief.question,
        subs = numbered(&brief.sub_questions),
        facts = fact_lines(claims),
    )
}

/// Ask the writer. `Ok(None)` when its reply can't be read (the caller uses
/// [`fallback_draft`]); `Err` when the call failed. `today` is `YYYY-MM-DD`.
pub async fn write(
    io: &dyn ResearchIo,
    brief: &ResearchBrief,
    claims: &[Labelled<'_>],
    today: &str,
) -> Result<Option<Draft>, String> {
    let data = ask_json(
        io,
        WRITER_SYSTEM,
        &writer_prompt(brief, claims, today),
        &writer_schema(),
    )
    .await?;
    Ok(data.and_then(|d| parse_draft(&d, brief.sub_questions.len())))
}

const REVIEW_SYSTEM: &str = "You review a research report draft against the facts it cites. \
You only correct the draft; you add no new facts. Reply with JSON only.";

fn review_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "fixes": {
                "type": "array",
                "maxItems": MAX_REVIEW_FIXES,
                "items": {
                    "type": "object",
                    "properties": {
                        "find": { "type": "string" },
                        "replace": { "type": "string" }
                    },
                    "required": ["find", "replace"]
                }
            }
        },
        "required": ["fixes"]
    })
}

fn review_prompt(
    brief: &ResearchBrief,
    draft: &Draft,
    claims: &[Labelled<'_>],
    today: &str,
) -> String {
    let mut text = format!("Summary:\n{}\n", draft.summary);
    let mut indexes: Vec<&usize> = draft.findings.keys().collect();
    indexes.sort();
    for index in indexes {
        let question = brief
            .sub_questions
            .get(*index)
            .map(|q| one_line(q))
            .unwrap_or_default();
        text.push_str(&format!(
            "\nFindings for sub-question {} ({question}):\n{}\n",
            index + 1,
            draft.findings[index]
        ));
    }
    if let Some(d) = &draft.disagreements {
        text.push_str(&format!("\nWhere sources disagree:\n{d}\n"));
    }
    format!(
        "Today is {today}.\nQuestion: {question}\n\n\
Facts the draft may cite, with each page's site and credibility:\n{facts}\n\n\
<draft>\n{text}</draft>\n\n\
Find every sentence of the draft that (a) says more than the facts it cites support (a wrong \
number or date, a dropped qualifier, the wrong source), (b) states a fact but cites no id, \
(c) contradicts another sentence of the draft, or (d) states a low-credibility fact as \
established. For each, give a fix: \"find\" is the sentence copied exactly from the draft, ids \
included; \"replace\" is the corrected sentence, citing only ids listed above, or \"\" to delete \
it. At most {MAX_REVIEW_FIXES} fixes. If nothing needs fixing, give \"fixes\": [].",
        question = brief.question,
        facts = fact_lines(claims),
    )
}

/// One exact-text correction the reviewer asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fix {
    pub find: String,
    /// Empty: delete the sentence `find` is in.
    pub replace: String,
}

/// Ask the reviewer for fixes to `draft`. `Ok(None)` when its reply can't be
/// read; `Err` when the call failed. Either way the caller keeps the draft.
pub async fn review(
    io: &dyn ResearchIo,
    brief: &ResearchBrief,
    draft: &Draft,
    claims: &[Labelled<'_>],
    today: &str,
) -> Result<Option<Vec<Fix>>, String> {
    let data = ask_json(
        io,
        REVIEW_SYSTEM,
        &review_prompt(brief, draft, claims, today),
        &review_schema(),
    )
    .await?;
    Ok(data.and_then(|d| parse_fixes(&d)))
}

/// The reviewer's fixes; `None` when the reply has no fix list at all. A fix
/// without a `find` or a `replace` string is left out.
fn parse_fixes(data: &Value) -> Option<Vec<Fix>> {
    let items = data["fixes"].as_array().or_else(|| data.as_array())?;
    Some(
        items
            .iter()
            .filter_map(|item| {
                let find = item["find"].as_str()?.trim();
                let replace = item["replace"].as_str()?.trim();
                (!find.is_empty() && find != replace).then(|| Fix {
                    find: find.to_string(),
                    replace: replace.to_string(),
                })
            })
            .take(MAX_REVIEW_FIXES)
            .collect(),
    )
}

/// Apply the reviewer's fixes to `draft`, in order, and return how many
/// were applied. A fix is skipped unless its `find` occurs exactly once in
/// the whole draft and its `replace` cites only labels in `claims`; and
/// unless it would leave the summary or a sub-question's findings empty (a
/// weak reviewer must not erase the report). An empty `replace` deletes the
/// sentence `find` is in.
pub fn apply_fixes(draft: &mut Draft, fixes: &[Fix], claims: &[Labelled<'_>]) -> usize {
    let known: HashSet<usize> = claims.iter().map(|c| c.label).collect();
    let mut applied = 0;
    for fix in fixes {
        if !labels_in(&fix.replace).iter().all(|l| known.contains(l)) {
            tracing::info!("research: skipped a review fix that cites an unknown label");
            continue;
        }
        let mut fields: Vec<&mut String> = vec![&mut draft.summary];
        let mut findings: Vec<(usize, &mut String)> =
            draft.findings.iter_mut().map(|(i, t)| (*i, t)).collect();
        findings.sort_by_key(|(i, _)| *i);
        fields.extend(findings.into_iter().map(|(_, t)| t));
        let disagreements_at = fields.len();
        if let Some(d) = draft.disagreements.as_mut() {
            fields.push(d);
        }
        let hits: Vec<usize> = fields
            .iter()
            .enumerate()
            .flat_map(|(i, f)| std::iter::repeat_n(i, f.matches(fix.find.as_str()).count()))
            .collect();
        let [field] = hits[..] else {
            tracing::info!(
                matches = hits.len(),
                "research: skipped a review fix whose text is not in the draft exactly once"
            );
            continue;
        };
        let text = &mut *fields[field];
        let fixed = replace_once(text, &fix.find, &fix.replace);
        if fixed.trim().is_empty() && field != disagreements_at {
            tracing::info!("research: skipped a review fix that would empty a section");
            continue;
        }
        *text = fixed;
        applied += 1;
    }
    if draft
        .disagreements
        .as_deref()
        .is_some_and(|d| d.trim().is_empty())
    {
        draft.disagreements = None;
    }
    applied
}

/// The `[C<n>]` labels `text` cites.
fn labels_in(text: &str) -> Vec<usize> {
    label_re()
        .find_iter(text)
        .flat_map(|m| label_numbers(m.as_str()))
        .collect()
}

/// The label numbers in one `[C…]` group. A range like `C51–C53` (hyphen,
/// en or em dash) stands for every label in it, up to 50 of them.
fn label_numbers(group: &str) -> Vec<usize> {
    let mut numbers = Vec::new();
    // The number before a dash, while a range is open.
    let mut range_from: Option<usize> = None;
    let mut in_range = false;
    let mut digits = String::new();
    let mut chars = group.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            digits.push(c);
            if chars.peek().is_some_and(|n| n.is_ascii_digit()) {
                continue;
            }
            let Ok(n) = digits.parse::<usize>() else {
                digits.clear();
                continue;
            };
            digits.clear();
            match range_from {
                Some(from) if in_range && n > from && n - from <= 50 => {
                    numbers.extend(from + 1..=n)
                }
                _ => numbers.push(n),
            }
            range_from = Some(n);
            in_range = false;
            continue;
        }
        match c {
            '-' | '\u{2013}' | '\u{2014}' => in_range = range_from.is_some(),
            ',' | ';' => {
                in_range = false;
                range_from = None;
            }
            _ => {}
        }
    }
    numbers
}

/// `text` with its one occurrence of `find` replaced; an empty `replace`
/// deletes the whole sentence `find` is in, and tidies what is left.
fn replace_once(text: &str, find: &str, replace: &str) -> String {
    let Some(start) = text.find(find) else {
        return text.to_string();
    };
    let end = start + find.len();
    if !replace.is_empty() {
        return format!("{}{replace}{}", &text[..start], &text[end..]);
    }
    let (start, end) = sentence_span(text, start, end);
    tidy(&format!("{}{}", &text[..start], &text[end..]))
}

/// The byte range of the sentence (or sentences) around `start..end`: back
/// to the previous sentence end or line start (keeping a bullet marker),
/// forward through the next sentence end and any labels after it. A
/// sentence that starts its line also takes the spaces after it, so the next
/// one moves up into its place.
fn sentence_span(text: &str, start: usize, end: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let ends_sentence = |i: usize| {
        matches!(bytes[i], b'.' | b'!' | b'?')
            && bytes.get(i + 1).is_none_or(|b| b.is_ascii_whitespace())
    };
    let mut s = start;
    while s > 0 && bytes[s - 1] != b'\n' && !ends_sentence(s - 1) {
        s -= 1;
    }
    let line_start = s == 0 || bytes[s - 1] == b'\n';
    if line_start {
        // Keep the bullet; an emptied bullet line is tidied away.
        let indent = text[s..].len() - text[s..].trim_start_matches([' ', '\t']).len();
        if text[s + indent..].starts_with("- ") || text[s + indent..].starts_with("* ") {
            s += indent + 2;
        }
    }
    let mut e = end;
    if !(e > start && ends_sentence(e - 1)) {
        while e < bytes.len() && bytes[e] != b'\n' {
            e += 1;
            if ends_sentence(e - 1) {
                break;
            }
        }
    }
    // "… fact. [C2]": the labels belong to the sentence.
    let rest = &text[e..];
    if let Some(m) = label_re().find(rest) {
        if rest[..m.start()].trim_matches([' ', '\t']).is_empty() {
            e += m.end();
        }
    }
    if line_start {
        e += text[e..].len() - text[e..].trim_start_matches([' ', '\t']).len();
    }
    (s, e)
}

/// Text after a deletion: no doubled spaces, no emptied bullet lines, at
/// most one blank line in a row, trimmed.
fn tidy(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        let body = line[indent..]
            .split(' ')
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if matches!(body.as_str(), "-" | "*") {
            continue;
        }
        if body.is_empty() && lines.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        lines.push(if body.is_empty() {
            String::new()
        } else {
            format!("{}{body}", &line[..indent])
        });
    }
    lines.join("\n").trim().to_string()
}

fn parse_draft(data: &Value, sub_questions: usize) -> Option<Draft> {
    let summary = strip_headings(data["summary"].as_str().unwrap_or_default());
    if summary.is_empty() {
        return None;
    }
    let mut findings: HashMap<usize, String> = HashMap::new();
    for item in data["findings"].as_array().into_iter().flatten() {
        let number = match &item["subQuestion"] {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        };
        let Some(index) = number
            .filter(|n| *n >= 1 && (*n as usize) <= sub_questions)
            .map(|n| n as usize - 1)
        else {
            continue;
        };
        let text = strip_headings(item["text"].as_str().unwrap_or_default());
        if text.is_empty() {
            continue;
        }
        findings
            .entry(index)
            .and_modify(|t| {
                t.push_str("\n\n");
                t.push_str(&text);
            })
            .or_insert(text);
    }
    let disagreements = data["disagreements"]
        .as_str()
        .map(strip_headings)
        .filter(|s| {
            !s.is_empty() && !s.eq_ignore_ascii_case("null") && !s.eq_ignore_ascii_case("none")
        });
    Some(Draft {
        summary,
        findings,
        disagreements,
    })
}

/// Text without heading lines (the report has its own) and trimmed.
fn strip_headings(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// A plain report built from the claims alone, for when the writer can't
/// run (out of budget, stopped) or its reply can't be read.
pub fn fallback_draft(sub_questions: usize, claims: &[Labelled<'_>]) -> Draft {
    let mut findings: HashMap<usize, String> = HashMap::new();
    let mut summary: Vec<String> = Vec::new();
    for index in 0..sub_questions {
        let mine: Vec<&Labelled<'_>> = claims
            .iter()
            .filter(|c| c.claim.sub_question == index)
            .collect();
        if let Some(first) = mine.first() {
            summary.push(format!(
                "{} [C{}]",
                end_sentence(&first.claim.claim),
                first.label
            ));
            let bullets = mine
                .iter()
                .take(10)
                .map(|c| format!("- {} [C{}]", end_sentence(&c.claim.claim), c.label))
                .collect::<Vec<_>>()
                .join("\n");
            findings.insert(index, bullets);
        }
    }
    Draft {
        summary: if summary.is_empty() {
            "No verified source answered the question.".to_string()
        } else {
            summary.join(" ")
        },
        findings,
        disagreements: None,
    }
}

fn end_sentence(text: &str) -> String {
    let t = text.trim();
    if t.ends_with(['.', '!', '?']) {
        t.to_string()
    } else {
        format!("{t}.")
    }
}

/// Labels → `[k]` citations, shared across the report so numbering follows
/// the order sources are first cited.
pub struct Citations<'a> {
    by_label: HashMap<usize, &'a Labelled<'a>>,
    /// Source ids in citation order: `order[k-1]` is `[k]`.
    order: Vec<String>,
    used_claims: HashSet<String>,
}

impl<'a> Citations<'a> {
    pub fn new(claims: &'a [Labelled<'a>]) -> Self {
        Self {
            by_label: claims.iter().map(|c| (c.label, c)).collect(),
            order: Vec::new(),
            used_claims: HashSet::new(),
        }
    }

    fn number_for(&mut self, label: usize) -> Option<usize> {
        let labelled = self.by_label.get(&label)?;
        self.used_claims.insert(labelled.claim.id.clone());
        let source = &labelled.source.id;
        let k = match self.order.iter().position(|s| s == source) {
            Some(i) => i + 1,
            None => {
                self.order.push(source.clone());
                self.order.len()
            }
        };
        Some(k)
    }

    /// Source ids in citation order.
    pub fn sources_in_order(&self) -> &[String] {
        &self.order
    }

    /// Ids of the claims the report cites.
    pub fn used_claims(&self) -> &HashSet<String> {
        &self.used_claims
    }

    /// `text` with `[C<n>]` labels (also `[C1, C3]`) turned into `[k]`
    /// citations; unknown labels, and citations or footnotes the writer typed
    /// itself, are removed.
    pub fn map(&mut self, text: &str) -> String {
        let cleaned: String = text
            .lines()
            // A footnote definition the writer added has nothing behind it.
            .filter(|l| !footnote_definition_re().is_match(l))
            .collect::<Vec<_>>()
            .join("\n");
        let cleaned = typed_footnote_re().replace_all(&cleaned, "");
        let cleaned = typed_number_re().replace_all(&cleaned, "");
        let mut out = String::with_capacity(cleaned.len());
        let mut last = 0;
        // The citation just written and where it ended, to drop a repeat.
        let mut previous: Option<(usize, usize)> = None;
        for found in label_re().find_iter(&cleaned) {
            let between = &cleaned[last..found.start()];
            let only_space = between.trim().is_empty();
            out.push_str(between);
            last = found.end();
            let mut numbers: Vec<usize> = Vec::new();
            for label in label_numbers(found.as_str()) {
                if let Some(k) = self.number_for(label) {
                    if !numbers.contains(&k) {
                        numbers.push(k);
                    }
                }
            }
            let trimmed_len = out.trim_end_matches([' ', '\t']).len();
            out.truncate(trimmed_len);
            let mut first = true;
            for k in numbers {
                let repeat =
                    matches!(previous, Some((p, end)) if p == k && only_space && end == out.len());
                if repeat {
                    continue;
                }
                // One space before a group of citations: "rose 31 percent [3][1]."
                let glued = matches!(previous, Some((_, end)) if end == out.len());
                if first && !glued && !out.is_empty() && !out.ends_with('\n') {
                    out.push(' ');
                }
                first = false;
                out.push_str(&format!("[{k}]"));
                previous = Some((k, out.len()));
            }
        }
        out.push_str(&cleaned[last..]);
        // "[2](" would read as a link.
        let out = cite_then_paren_re().replace_all(&out, "$1 (");
        out.trim().to_string()
    }
}

fn label_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\s*[Cc]\s*\d+(?:\s*[,;\-\u{2013}\u{2014}]\s*[Cc]?\s*\d+)*\s*\]")
            .expect("label regex")
    })
}

fn typed_footnote_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]*\[\^[^\]]*\]").expect("footnote regex"))
}

/// `[3]` or `[1, 2]` the writer typed itself; only code numbers citations.
fn typed_number_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]*\[\s*\d+(?:\s*,\s*\d+)*\s*\]").expect("number regex"))
}

fn cite_then_paren_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(\[\d+\])\(").expect("paren regex"))
}

fn footnote_definition_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*\[\^[^\]]*\]:").expect("definition regex"))
}

/// Everything the report shows.
pub struct ReportInput<'a> {
    pub brief: &'a ResearchBrief,
    /// `YYYY-MM-DD`, the run's finish date.
    pub date: &'a str,
    pub draft: &'a Draft,
    pub claims: &'a [Labelled<'a>],
    pub sources: &'a [SourceRecord],
    /// Sub-question indexes with no verified claim.
    pub unanswered: &'a [usize],
    /// Why the run ended early, said at the top; `None` when it finished.
    pub note: Option<&'a str>,
}

/// The rendered report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub markdown: String,
    /// The Summary section's text, `[k]` citations in.
    pub summary: String,
    /// Citation number per cited source id (its place in Sources).
    pub footnotes: HashMap<String, u32>,
    /// Claim ids the report cites.
    pub used_claims: HashSet<String>,
}

fn depth_label(depth: ResearchDepth) -> &'static str {
    match depth {
        ResearchDepth::Quick => "Quick",
        ResearchDepth::Standard => "Standard",
        ResearchDepth::Deep => "Deep",
    }
}

/// Build the report Markdown.
pub fn render(input: &ReportInput<'_>) -> Rendered {
    let brief = input.brief;
    let mut citations = Citations::new(input.claims);
    let summary = citations.map(&input.draft.summary);
    let fallback = fallback_draft(brief.sub_questions.len(), input.claims);
    // Sub-questions nothing answered are listed under Open questions only.
    let mut findings = Vec::new();
    for (index, question) in brief.sub_questions.iter().enumerate() {
        if input.unanswered.contains(&index) {
            continue;
        }
        let text = input
            .draft
            .findings
            .get(&index)
            .or_else(|| fallback.findings.get(&index))
            .map(|t| citations.map(t))
            .unwrap_or_default();
        if !text.is_empty() {
            findings.push(format!("### {}\n\n{text}", one_line(question)));
        }
    }
    let disagreements = input
        .draft
        .disagreements
        .as_deref()
        .map(|d| citations.map(d))
        .filter(|d| !d.is_empty());

    let by_id: HashMap<&str, &SourceRecord> =
        input.sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let cited = citations.sources_in_order().to_vec();
    let mut footnotes = HashMap::new();
    let mut entries = Vec::new();
    for (i, id) in cited.iter().enumerate() {
        let k = i + 1;
        footnotes.insert(id.clone(), k as u32);
        if let Some(source) = by_id.get(id.as_str()) {
            entries.push(format!(
                "{k}. {} — {} — fetched {}{}",
                source_link(source),
                source.host,
                date_of(&source.fetched_at),
                low_credibility_mark(&source.rating),
            ));
        }
    }
    let others: Vec<String> = input
        .sources
        .iter()
        .filter(|s| !footnotes.contains_key(&s.id))
        .take(MAX_OTHER_PAGES)
        .map(|s| {
            let state = match s.status {
                ResearchSourceStatus::Read => low_credibility_mark(&s.rating),
                ResearchSourceStatus::Empty => " (no readable text)".to_string(),
                ResearchSourceStatus::Failed => " (could not be read)".to_string(),
                ResearchSourceStatus::Skipped => " (skipped)".to_string(),
            };
            format!("- {} — {}{state}", source_link(s), s.host)
        })
        .collect();

    let count = cited.len();
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", one_line(&brief.question)));
    md.push_str(&format!(
        "*Researched {} · {count} source{} · {}*\n\n",
        input.date,
        if count == 1 { "" } else { "s" },
        depth_label(brief.depth)
    ));
    if let Some(note) = input.note {
        md.push_str(&format!("> {note}\n\n"));
    }
    md.push_str(&format!("## Summary\n\n{summary}\n\n"));
    if !findings.is_empty() {
        md.push_str("## Findings\n\n");
        md.push_str(&findings.join("\n\n"));
        md.push_str("\n\n");
    }
    if let Some(d) = &disagreements {
        md.push_str(&format!("## Where sources disagree\n\n{d}\n\n"));
    }
    if !input.unanswered.is_empty() {
        md.push_str("## Open questions\n\n");
        for index in input.unanswered {
            if let Some(q) = brief.sub_questions.get(*index) {
                let hosts = unreadable_hosts(input.sources, *index);
                let unread = if hosts.is_empty() {
                    String::new()
                } else {
                    format!(" (pages that could not be read: {})", hosts.join(", "))
                };
                md.push_str(&format!("- {}{unread}\n", one_line(q)));
            }
        }
        md.push('\n');
    }
    md.push_str("## Sources\n\n");
    if entries.is_empty() {
        md.push_str("*No source is cited.*\n");
    } else {
        md.push_str(&entries.join("\n"));
        md.push('\n');
    }
    if !others.is_empty() {
        md.push_str("\nAlso read, not cited:\n\n");
        md.push_str(&others.join("\n"));
        md.push('\n');
    }

    Rendered {
        markdown: md,
        summary,
        footnotes,
        used_claims: citations.used_claims().clone(),
    }
}

/// ` (low credibility: <reason>)` for a page rated low; nothing otherwise.
fn low_credibility_mark(rating: &SourceRating) -> String {
    match (rating.credibility, rating.reason.is_empty()) {
        (Credibility::Low, false) => format!(" (low credibility: {})", rating.reason),
        (Credibility::Low, true) => " (low credibility)".to_string(),
        _ => String::new(),
    }
}

/// Hosts of the pages chosen for `sub_question` that could not be read
/// (failed or empty), deduplicated, at most [`MAX_UNREADABLE_HOSTS`]: an
/// unanswered question's answer may well have been on one of them.
fn unreadable_hosts(sources: &[SourceRecord], sub_question: usize) -> Vec<&str> {
    let mut hosts: Vec<&str> = Vec::new();
    for source in sources.iter().filter(|s| {
        s.sub_question == Some(sub_question)
            && matches!(
                s.status,
                ResearchSourceStatus::Failed | ResearchSourceStatus::Empty
            )
    }) {
        if !source.host.is_empty() && !hosts.contains(&source.host.as_str()) {
            hosts.push(&source.host);
        }
        if hosts.len() == MAX_UNREADABLE_HOSTS {
            break;
        }
    }
    hosts
}

fn source_title(source: &SourceRecord) -> String {
    let title = source
        .title
        .as_deref()
        .map(one_line)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| source.host.clone());
    // Brackets would end the link text early; `*` and backticks would start
    // emphasis or code.
    clip(&title.replace(['[', ']', '*', '`'], ""), 160)
}

/// `[Title](url)`, with the characters that would end the link escaped.
fn source_link(source: &SourceRecord) -> String {
    let url = source
        .shown_url()
        .replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
        .replace('<', "%3C")
        .replace('>', "%3E");
    format!("[{}]({url})", source_title(source))
}

fn date_of(at: &str) -> &str {
    at.get(..10).unwrap_or(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_ranges_are_read_as_every_label_in_them() {
        assert_eq!(label_numbers("[C9, C10]"), vec![9, 10]);
        assert_eq!(label_numbers("[C51\u{2013}C53]"), vec![51, 52, 53]);
        assert_eq!(label_numbers("[C1-3; C7]"), vec![1, 2, 3, 7]);
        assert_eq!(label_numbers("[C4\u{2014}C2]"), vec![4, 2]);
        let text = "Prices rose. [C9, C10, C11, C51\u{2013}C53]";
        assert_eq!(label_re().find_iter(text).count(), 1);
        assert_eq!(labels_in(text), vec![9, 10, 11, 51, 52, 53]);
    }

    fn source(id: &str, host: &str) -> SourceRecord {
        SourceRecord {
            id: id.into(),
            url: format!("https://{host}/page"),
            final_url: None,
            title: Some(format!("Title {id}")),
            host: host.into(),
            fetched_at: "2026-10-01T10:00:00.000Z".into(),
            status: ResearchSourceStatus::Read,
            text: String::new(),
            content_hash: None,
            rating: SourceRating::default(),
            sub_question: Some(0),
        }
    }

    fn claim(id: &str, source: &str, sub: usize) -> ClaimRecord {
        ClaimRecord {
            id: id.into(),
            sub_question: sub,
            claim: format!("Claim {id}."),
            quote: "a quote long enough to count here".into(),
            source_id: source.into(),
            verified: true,
        }
    }

    #[test]
    fn labels_map_to_numbers_by_source_in_first_cited_order() {
        let sources = vec![source("s1", "a.com"), source("s2", "b.org")];
        let claims = vec![
            claim("c1", "s1", 0),
            claim("c2", "s2", 0),
            claim("c3", "s1", 0),
        ];
        let labelled = label_claims(&claims, &sources, 1);
        assert_eq!(labelled.len(), 3);
        let mut cites = Citations::new(&labelled);
        // C2 (b.org) is cited first, so b.org is [1]; C1 and C3 share a.com.
        let text =
            cites.map("First [C2]. Second [C1]. Third [C3]. Fake [C99]. Typed [^7] and [4, 5].");
        assert_eq!(text, "First [1]. Second [2]. Third [2]. Fake. Typed and.");
        assert_eq!(cites.sources_in_order(), ["s2", "s1"]);
        assert_eq!(cites.used_claims().len(), 3);
    }

    #[test]
    fn grouped_and_repeated_labels_collapse() {
        let sources = vec![source("s1", "a.com"), source("s2", "b.org")];
        let claims = vec![
            claim("c1", "s1", 0),
            claim("c2", "s1", 0),
            claim("c3", "s2", 0),
        ];
        let labelled = label_claims(&claims, &sources, 1);
        let mut cites = Citations::new(&labelled);
        assert_eq!(cites.map("Both [C1, C2]."), "Both [1].");
        assert_eq!(
            cites.map("Again [C1][C2] and [c3; C1]."),
            "Again [1] and [2][1]."
        );
        assert_eq!(cites.map("[C1] starts it."), "[1] starts it.");
        // A citation followed by "(" must not read as a link.
        assert_eq!(cites.map("Rate [C3](2025)."), "Rate [2] (2025).");
    }

    #[test]
    fn render_uses_only_markdown_the_app_draws() {
        let mut sources = vec![source("s1", "a.com"), source("s2", "b.org")];
        sources.push(SourceRecord {
            status: ResearchSourceStatus::Failed,
            ..source("s3", "c.net")
        });
        sources[1].title = Some("A [bracketed] *title*".into());
        sources[1].final_url = Some("https://b.org/a page (1)".into());
        let claims = vec![claim("c1", "s1", 0), claim("c2", "s2", 0)];
        let labelled = label_claims(&claims, &sources, 2);
        let brief = ResearchBrief {
            question: "Why?".into(),
            sub_questions: vec!["One?".into(), "Two?".into()],
            scope: None,
            prefer_domains: vec![],
            avoid_domains: vec![],
            depth: ResearchDepth::Quick,
        };
        let draft = Draft {
            summary: "It is so [C2]. Also [C1]. Made up [C5].".into(),
            findings: HashMap::from([
                (0, "Detail [C1].".into()),
                (1, "No data was found [C2].".into()),
            ]),
            disagreements: None,
        };
        let r = render(&ReportInput {
            brief: &brief,
            date: "2026-10-03",
            draft: &draft,
            claims: &labelled,
            sources: &sources,
            unanswered: &[1],
            note: None,
        });
        let md = &r.markdown;
        assert_eq!(r.summary, "It is so [1]. Also [2]. Made up.");
        assert!(
            md.starts_with("# Why?\n\n*Researched 2026-10-03 · 2 sources · Quick*\n\n"),
            "{md}"
        );
        assert!(md.contains("### One?\n\nDetail [2]."), "{md}");
        // An unanswered sub-question is only an open question, whatever the writer wrote.
        assert!(!md.contains("### Two?"), "{md}");
        assert!(!md.contains("No data was found"), "{md}");
        assert!(md.contains("## Open questions\n\n- Two?"), "{md}");
        assert!(
            md.contains(
                "## Sources\n\n1. [A bracketed title](https://b.org/a%20page%20%281%29) — b.org — fetched 2026-10-01\n\
2. [Title s1](https://a.com/page) — a.com — fetched 2026-10-01\n"
            ),
            "{md}"
        );
        assert!(
            md.contains("Also read, not cited:\n\n- [Title s3](https://c.net/page) — c.net (could not be read)"),
            "{md}"
        );
        // Nothing the app's Markdown can't draw.
        assert!(!md.contains("[^"), "{md}");
        assert!(!md.contains("_Researched"), "{md}");
        assert!(!md.contains('|'), "{md}");
        assert_eq!(r.footnotes.get("s2"), Some(&1));
    }

    fn rated(id: &str, host: &str, credibility: Credibility, reason: &str) -> SourceRecord {
        SourceRecord {
            rating: SourceRating {
                kind: "unknown",
                credibility,
                reason: reason.into(),
            },
            ..source(id, host)
        }
    }

    fn one_question_brief(subs: &[&str]) -> ResearchBrief {
        ResearchBrief {
            question: "Why?".into(),
            sub_questions: subs.iter().map(|s| s.to_string()).collect(),
            scope: None,
            prefer_domains: vec![],
            avoid_domains: vec![],
            depth: ResearchDepth::Quick,
        }
    }

    #[test]
    fn credible_claims_come_first_within_a_sub_question() {
        let sources = vec![
            rated(
                "low",
                "archive.example",
                Credibility::Low,
                "unreviewed archive",
            ),
            source("mid", "blog.example"),
            rated("high", "agency.gov", Credibility::High, ""),
        ];
        let claims = vec![
            claim("c-low", "low", 0),
            claim("c-mid", "mid", 0),
            claim("c-high", "high", 0),
            claim("c-other", "low", 1),
        ];
        let labelled = label_claims(&claims, &sources, 2);
        let order: Vec<_> = labelled.iter().map(|l| l.claim.id.as_str()).collect();
        assert_eq!(order, ["c-high", "c-mid", "c-low", "c-other"]);

        // The writer sees each claim's site and rating; the reason only for a low one.
        let prompt = writer_prompt(&one_question_brief(&["A?", "B?"]), &labelled, "2026-10-06");
        assert!(prompt.starts_with("Today is 2026-10-06.\n"), "{prompt}");
        assert!(
            prompt.contains("[C1] (sub-question 1; agency.gov · high) Claim c-high."),
            "{prompt}"
        );
        assert!(
            prompt.contains("[C2] (sub-question 1; blog.example · medium)"),
            "{prompt}"
        );
        assert!(
            prompt.contains("[C3] (sub-question 1; archive.example · low: unreviewed archive)"),
            "{prompt}"
        );
        assert!(
            prompt.contains("anything before 2026-10-06 is past"),
            "{prompt}"
        );
    }

    #[test]
    fn the_writer_cap_drops_low_credibility_claims_first() {
        let sources = vec![
            rated("low", "archive.example", Credibility::Low, ""),
            source("ok", "news.example"),
        ];
        let mut claims: Vec<ClaimRecord> = (0..MAX_WRITER_CLAIMS)
            .map(|i| claim(&format!("low{i}"), "low", 0))
            .collect();
        claims.push(claim("good", "ok", 0));
        let labelled = label_claims(&claims, &sources, 1);
        assert_eq!(labelled.len(), MAX_WRITER_CLAIMS);
        assert_eq!(labelled[0].claim.id, "good");
    }

    #[test]
    fn low_credibility_sources_are_marked_and_unreadable_hosts_named() {
        let mut sources = vec![
            rated(
                "s1",
                "archive.example",
                Credibility::Low,
                "AI-written archive",
            ),
            rated("s2", "forum.example", Credibility::Low, ""),
            source("s3", "agency.gov"),
        ];
        for (i, host) in [
            "blocked.org",
            "js.example",
            "blocked.org",
            "a.net",
            "b.net",
            "c.net",
        ]
        .iter()
        .enumerate()
        {
            sources.push(SourceRecord {
                status: if i % 2 == 0 {
                    ResearchSourceStatus::Failed
                } else {
                    ResearchSourceStatus::Empty
                },
                sub_question: Some(1),
                ..source(&format!("f{i}"), host)
            });
        }
        // A page that failed for an answered sub-question isn't named.
        sources.push(SourceRecord {
            status: ResearchSourceStatus::Failed,
            ..source("f-other", "elsewhere.org")
        });
        let claims = vec![claim("c1", "s1", 0), claim("c3", "s3", 0)];
        let labelled = label_claims(&claims, &sources, 2);
        let draft = Draft {
            summary: "Fact [C1]. Other [C2].".into(),
            findings: HashMap::new(),
            disagreements: None,
        };
        let r = render(&ReportInput {
            brief: &one_question_brief(&["One?", "Two?"]),
            date: "2026-10-06",
            draft: &draft,
            claims: &labelled,
            sources: &sources,
            unanswered: &[1],
            note: None,
        });
        let md = &r.markdown;
        // C1 is agency.gov (credible first), C2 the archive.
        assert!(
            md.contains(
                "1. [Title s3](https://agency.gov/page) — agency.gov — fetched 2026-10-01\n"
            ),
            "{md}"
        );
        assert!(
            md.contains("2. [Title s1](https://archive.example/page) — archive.example — fetched 2026-10-01 (low credibility: AI-written archive)\n"),
            "{md}"
        );
        assert!(
            md.contains(
                "- [Title s2](https://forum.example/page) — forum.example (low credibility)"
            ),
            "{md}"
        );
        assert!(
            md.contains("## Open questions\n\n- Two? (pages that could not be read: blocked.org, js.example, a.net, b.net)\n"),
            "{md}"
        );
        assert!(!md.contains("elsewhere.org (pages"), "{md}");
    }

    fn fix(find: &str, replace: &str) -> Fix {
        Fix {
            find: find.into(),
            replace: replace.into(),
        }
    }

    #[test]
    fn review_fixes_apply_only_when_exact_and_citing_real_labels() {
        let sources = vec![source("s1", "a.com")];
        let claims = vec![claim("c1", "s1", 0), claim("c2", "s1", 0)];
        let labelled = label_claims(&claims, &sources, 2);
        let mut draft = Draft {
            summary: "Rates rose 5 percent [C1]. Rates are high. Costs fell [C2].".into(),
            findings: HashMap::from([
                (
                    0,
                    "- Rates rose 5 percent in 2025 [C1].\n- Costs fell [C2].".into(),
                ),
                (1, "Only sentence [C2].".into()),
            ]),
            disagreements: Some("Sources differ on rates [C1, C2].".into()),
        };
        let fixes = vec![
            // Exact and unique: applied.
            fix("Rates rose 5 percent [C1].", "Rates rose 4 percent [C1]."),
            // An uncited sentence is deleted, with its space.
            fix("Rates are high.", ""),
            // In the draft twice: skipped.
            fix("Costs fell [C2].", "Costs fell sharply [C2]."),
            // Not in the draft: skipped.
            fix("Rates doubled [C1].", ""),
            // Cites a label that doesn't exist: skipped.
            fix("Rates rose 5 percent in 2025 [C1].", "Rates rose [C7]."),
            // Would empty a sub-question's findings: skipped.
            fix("Only sentence [C2].", ""),
            // The disagreements section may go entirely.
            fix("Sources differ on rates", ""),
            // A part of a sentence deletes the whole bullet.
            fix("in 2025", ""),
        ];
        assert_eq!(apply_fixes(&mut draft, &fixes, &labelled), 4);
        assert_eq!(draft.summary, "Rates rose 4 percent [C1]. Costs fell [C2].");
        assert_eq!(draft.findings[&0], "- Costs fell [C2].");
        assert_eq!(draft.findings[&1], "Only sentence [C2].");
        assert_eq!(draft.disagreements, None);
    }

    #[test]
    fn deleting_a_sentence_tidies_what_is_left() {
        assert_eq!(
            replace_once("A one [C1]. B two [C2]. C three.", "B two", ""),
            "A one [C1]. C three."
        );
        assert_eq!(
            replace_once("A one [C1]. B two.", "A one [C1].", ""),
            "B two."
        );
        assert_eq!(replace_once("A one. [C1] B two.", "A one.", ""), "B two.");
        assert_eq!(
            replace_once(
                "First para [C1].\n\nSecond para [C2].\n\nThird [C3].",
                "Second para [C2].",
                ""
            ),
            "First para [C1].\n\nThird [C3]."
        );
        assert_eq!(
            replace_once(
                "- Keep 1.5 percent [C1].\n- Drop me [C2]. And me.\n- Keep [C3].",
                "Drop me",
                ""
            ),
            "- Keep 1.5 percent [C1].\n- And me.\n- Keep [C3]."
        );
    }

    #[test]
    fn review_replies_are_read_leniently() {
        let fixes = parse_fixes(&json!({ "fixes": [
            { "find": " Old [C1]. ", "replace": "New [C1]." },
            { "find": "No replace" },
            { "find": "", "replace": "x" },
            { "find": "Same", "replace": "Same" },
            { "find": "Gone.", "replace": "" }
        ]}))
        .unwrap();
        assert_eq!(fixes, vec![fix("Old [C1].", "New [C1]."), fix("Gone.", "")]);
        assert_eq!(parse_fixes(&json!({ "nothing": 1 })), None);
        let many: Vec<_> = (0..30)
            .map(|i| json!({ "find": format!("s{i}"), "replace": "" }))
            .collect();
        assert_eq!(
            parse_fixes(&json!({ "fixes": many })).unwrap().len(),
            MAX_REVIEW_FIXES
        );
    }
}
