//! The report: the writer call, then everything that makes it trustworthy,
//! done by code.
//!
//! The writer sees the brief and the verified claims, each labelled `C<n>`
//! with its host — never page text — and cites by label. Code then turns
//! labels into `[^k]` footnotes numbered by source in first-cited order,
//! drops labels that name no verified claim (and any footnote the writer
//! typed itself), and renders the Sources section from the stored sources.
//! A sentence can therefore only point at a page the run read and whose
//! quote it found.

use std::collections::{HashMap, HashSet};

use provider_core::schema::{ResearchBrief, ResearchDepth, ResearchSourceStatus};
use regex::Regex;
use serde_json::{json, Value};

use super::run::{ClaimRecord, SourceRecord};
use super::{ask_json, clip, one_line, ResearchIo};

/// Most claims shown to the writer, spread across the sub-questions.
pub const MAX_WRITER_CLAIMS: usize = 60;
/// Most uncited pages listed under Sources.
const MAX_OTHER_PAGES: usize = 50;
const NO_ANSWER: &str = "_No verified source answered this._";

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
/// from each sub-question so none crowds out the rest.
pub fn label_claims<'a>(
    claims: &'a [ClaimRecord],
    sources: &'a [SourceRecord],
    sub_questions: usize,
) -> Vec<Labelled<'a>> {
    let by_id: HashMap<&str, &SourceRecord> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut queues: Vec<Vec<&ClaimRecord>> = vec![Vec::new(); sub_questions.max(1)];
    for claim in claims.iter().filter(|c| c.verified) {
        if let Some(queue) = queues.get_mut(claim.sub_question) {
            queue.push(claim);
        }
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
    // Keep the extraction order (and with it, page order) for the labels.
    let order: HashMap<&str, usize> = claims
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.as_str(), i))
        .collect();
    picked.sort_by_key(|c| order.get(c.id.as_str()).copied().unwrap_or(usize::MAX));
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

fn writer_prompt(brief: &ResearchBrief, claims: &[Labelled<'_>]) -> String {
    let subs = brief
        .sub_questions
        .iter()
        .enumerate()
        .map(|(i, q)| format!("{}. {q}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let facts = claims
        .iter()
        .map(|c| {
            format!(
                "[C{}] (sub-question {}; {}) {} Quote: \"{}\"",
                c.label,
                c.claim.sub_question + 1,
                c.source.host,
                c.claim.claim,
                clip(&one_line(&c.claim.quote), 200)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let scope = brief
        .scope
        .as_deref()
        .map(|s| format!("Scope: {s}\n"))
        .unwrap_or_default();
    format!(
        "Question: {question}\n{scope}Sub-questions:\n{subs}\n\n\
Facts, each checked against its source page:\n{facts}\n\n\
Write the report from these facts only.\n\
summary: 5 to 8 sentences that answer the question. End every sentence with the ids of the \
facts it rests on, like [C2] or [C1, C4].\n\
findings: for each sub-question that has facts, a short paragraph or a few \"- \" bullets, \
with ids after every sentence.\n\
disagreements: if facts conflict, a short paragraph naming both sides with their ids; else null.\n\
Never invent facts, numbers or ids. No title, headings, links or source list.",
        question = brief.question
    )
}

/// Ask the writer. `Ok(None)` when its reply can't be read (the caller uses
/// [`fallback_draft`]); `Err` when the call failed.
pub async fn write(
    io: &dyn ResearchIo,
    brief: &ResearchBrief,
    claims: &[Labelled<'_>],
) -> Result<Option<Draft>, String> {
    let data = ask_json(
        io,
        WRITER_SYSTEM,
        &writer_prompt(brief, claims),
        &writer_schema(),
    )
    .await?;
    Ok(data.and_then(|d| parse_draft(&d, brief.sub_questions.len())))
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

/// Labels → footnotes, shared across the report so numbering follows the
/// order sources are first cited.
pub struct Citations<'a> {
    by_label: HashMap<usize, &'a Labelled<'a>>,
    /// Source ids in footnote order: `order[k-1]` is `[^k]`.
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

    fn footnote_for(&mut self, label: usize) -> Option<usize> {
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

    /// Source ids in footnote order.
    pub fn sources_in_order(&self) -> &[String] {
        &self.order
    }

    /// Ids of the claims the report cites.
    pub fn used_claims(&self) -> &HashSet<String> {
        &self.used_claims
    }

    /// `text` with `[C<n>]` labels (also `[C1, C3]`) turned into `[^k]`
    /// footnotes; unknown labels and footnotes the writer typed are removed.
    pub fn map(&mut self, text: &str) -> String {
        let typed_footnote = typed_footnote_re();
        let cleaned: String = text
            .lines()
            // A footnote definition the writer added has nothing behind it.
            .filter(|l| !footnote_definition_re().is_match(l))
            .collect::<Vec<_>>()
            .join("\n");
        let cleaned = typed_footnote.replace_all(&cleaned, "");
        let mut out = String::with_capacity(cleaned.len());
        let mut last = 0;
        // The footnote just written and where it ended, to drop a repeat.
        let mut previous: Option<(usize, usize)> = None;
        for found in label_re().find_iter(&cleaned) {
            let between = &cleaned[last..found.start()];
            let only_space = between.trim().is_empty();
            out.push_str(between);
            last = found.end();
            let mut notes: Vec<usize> = Vec::new();
            for label in found
                .as_str()
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|d| d.parse::<usize>().ok())
            {
                if let Some(k) = self.footnote_for(label) {
                    if !notes.contains(&k) {
                        notes.push(k);
                    }
                }
            }
            // Footnotes sit right after the word or punctuation they follow.
            let trimmed_len = out.trim_end_matches([' ', '\t']).len();
            out.truncate(trimmed_len);
            for k in notes {
                let repeat = matches!(previous, Some((p, end)) if p == k && only_space && end == trimmed_len);
                if !repeat {
                    out.push_str(&format!("[^{k}]"));
                }
                previous = Some((k, out.len()));
            }
        }
        out.push_str(&cleaned[last..]);
        out.trim().to_string()
    }
}

fn label_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\s*[Cc]\s*\d+(?:\s*[,;]\s*[Cc]?\s*\d+)*\s*\]").expect("label regex")
    })
}

fn typed_footnote_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]*\[\^[^\]]*\]").expect("footnote regex"))
}

fn footnote_definition_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*\[\^[^\]]*\]:").expect("definition regex"))
}

/// `[^k]` markers removed, for plain text without the Sources section.
pub fn strip_footnotes(text: &str) -> String {
    let stripped = typed_footnote_re().replace_all(text, "");
    stripped.trim().to_string()
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
    /// The Summary section's text, footnotes in.
    pub summary: String,
    /// Footnote number per cited source id.
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
    let mut findings = Vec::new();
    for (index, question) in brief.sub_questions.iter().enumerate() {
        let body = if input.unanswered.contains(&index) {
            NO_ANSWER.to_string()
        } else {
            let text = input
                .draft
                .findings
                .get(&index)
                .or_else(|| fallback.findings.get(&index))
                .map(|t| citations.map(t))
                .unwrap_or_default();
            if text.is_empty() {
                NO_ANSWER.to_string()
            } else {
                text
            }
        };
        findings.push(format!("### {}\n\n{body}", one_line(question)));
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
    let mut definitions = Vec::new();
    for (i, id) in cited.iter().enumerate() {
        let k = i + 1;
        footnotes.insert(id.clone(), k as u32);
        if let Some(source) = by_id.get(id.as_str()) {
            definitions.push(format!(
                "[^{k}]: {} — {} — {} — {}",
                source_title(source),
                source.host,
                date_of(&source.fetched_at),
                source.shown_url()
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
                ResearchSourceStatus::Read => "",
                ResearchSourceStatus::Empty => " (no readable text)",
                ResearchSourceStatus::Failed => " (could not be read)",
                ResearchSourceStatus::Skipped => " (skipped)",
            };
            format!(
                "- {} — {} — {}{state}",
                source_title(s),
                s.host,
                s.shown_url()
            )
        })
        .collect();

    let count = cited.len();
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", one_line(&brief.question)));
    md.push_str(&format!(
        "_Researched {} · {count} source{} · {}_\n\n",
        input.date,
        if count == 1 { "" } else { "s" },
        depth_label(brief.depth)
    ));
    if let Some(note) = input.note {
        md.push_str(&format!("> {note}\n\n"));
    }
    md.push_str(&format!("## Summary\n\n{summary}\n\n"));
    md.push_str("## Findings\n\n");
    md.push_str(&findings.join("\n\n"));
    md.push_str("\n\n");
    if let Some(d) = &disagreements {
        md.push_str(&format!("## Where sources disagree\n\n{d}\n\n"));
    }
    if !input.unanswered.is_empty() {
        md.push_str("## Open questions\n\n");
        for index in input.unanswered {
            if let Some(q) = brief.sub_questions.get(*index) {
                md.push_str(&format!("- {}\n", one_line(q)));
            }
        }
        md.push('\n');
    }
    md.push_str("## Sources\n\n");
    if definitions.is_empty() {
        md.push_str("_No source is cited._\n");
    } else {
        md.push_str(&definitions.join("\n"));
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

fn source_title(source: &SourceRecord) -> String {
    let title = source
        .title
        .as_deref()
        .map(one_line)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| source.host.clone());
    // Brackets would read as link syntax in a footnote line.
    clip(&title.replace(['[', ']'], ""), 160)
}

fn date_of(at: &str) -> &str {
    at.get(..10).unwrap_or(at)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn labels_map_to_footnotes_by_source_in_first_cited_order() {
        let sources = vec![source("s1", "a.com"), source("s2", "b.org")];
        let claims = vec![
            claim("c1", "s1", 0),
            claim("c2", "s2", 0),
            claim("c3", "s1", 0),
        ];
        let labelled = label_claims(&claims, &sources, 1);
        assert_eq!(labelled.len(), 3);
        let mut cites = Citations::new(&labelled);
        // C2 (b.org) is cited first, so b.org is [^1]; C1 and C3 share a.com.
        let text = cites.map("First [C2]. Second [C1]. Third [C3]. Fake [C99]. Typed [^7].");
        assert_eq!(text, "First[^1]. Second[^2]. Third[^2]. Fake. Typed.");
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
        assert_eq!(cites.map("Both [C1, C2]."), "Both[^1].");
        assert_eq!(
            cites.map("Again [C1][C2] and [c3; C1]."),
            "Again[^1] and[^2][^1]."
        );
    }

    #[test]
    fn render_lists_cited_sources_open_questions_and_others() {
        let mut sources = vec![source("s1", "a.com"), source("s2", "b.org")];
        sources.push(SourceRecord {
            status: ResearchSourceStatus::Failed,
            ..source("s3", "c.net")
        });
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
            findings: HashMap::from([(0, "Detail [C1].".into()), (1, "Invented [C2].".into())]),
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
        assert_eq!(r.summary, "It is so[^1]. Also[^2]. Made up.");
        assert!(r
            .markdown
            .starts_with("# Why?\n\n_Researched 2026-10-03 · 2 sources · Quick_"));
        assert!(r
            .markdown
            .contains("[^1]: Title s2 — b.org — 2026-10-01 — https://b.org/page"));
        assert!(r
            .markdown
            .contains("[^2]: Title s1 — a.com — 2026-10-01 — https://a.com/page"));
        // An unanswered sub-question says so, whatever the writer wrote.
        assert!(r
            .markdown
            .contains("### Two?\n\n_No verified source answered this._"));
        assert!(!r.markdown.contains("Invented"));
        assert!(r.markdown.contains("## Open questions\n\n- Two?"));
        assert!(r
            .markdown
            .contains("- Title s3 — c.net — https://c.net/page (could not be read)"));
        assert_eq!(r.footnotes.get("s2"), Some(&1));
        assert_eq!(strip_footnotes(&r.summary), "It is so. Also. Made up.");
    }
}
