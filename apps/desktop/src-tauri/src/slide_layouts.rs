//! Typed slides: a layout plus its fields (headline, bullets, stats, ...),
//! checked against per-layout budgets and built into the slide HTML the
//! theme expects, with deterministic slot names. A slide built this way can
//! be read back into its fields, so an update can merge onto it.
//!
//! The `custom` layout is the escape hatch: the model writes the inner HTML
//! itself and none of this applies beyond the usual HTML checks.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::db::repository::slides::slide_visible_text;
use crate::slide_charts::{self, PictureBox};
use crate::slide_html::{self, TokKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    Title,
    Statement,
    Bullets,
    StatRow,
    TwoCol,
    Quote,
    Section,
    ImageLeft,
    Chart,
    Custom,
}

/// Every layout name, in the order the tools list them.
pub const LAYOUT_NAMES: [&str; 10] = [
    "title",
    "statement",
    "bullets",
    "stat-row",
    "two-col",
    "quote",
    "section",
    "image-left",
    "chart",
    "custom",
];

/// Every field a layout can take, in the order the builder and the errors use.
pub const FIELD_NAMES: [&str; 13] = [
    "kicker", "headline", "sub", "body", "bullets", "stats", "columns", "quote", "cite", "chart",
    "svg", "footnote", "html",
];

const KICKER_WORDS: usize = 4;
const SUB_WORDS: usize = 20;
const BODY_WORDS: usize = 30;
const QUOTE_WORDS: usize = 30;
const CITE_WORDS: usize = 8;
const FOOTNOTE_WORDS: usize = 20;
const STAT_VALUE_CHARS: usize = 6;
const STAT_LABEL_WORDS: usize = 8;
const COLUMN_KICKER_WORDS: usize = 4;
const COLUMN_BODY_WORDS: usize = 30;

impl Layout {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "title" => Self::Title,
            "statement" => Self::Statement,
            "bullets" => Self::Bullets,
            "stat-row" => Self::StatRow,
            "two-col" => Self::TwoCol,
            "quote" => Self::Quote,
            "section" => Self::Section,
            "image-left" => Self::ImageLeft,
            "chart" => Self::Chart,
            "custom" => Self::Custom,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Statement => "statement",
            Self::Bullets => "bullets",
            Self::StatRow => "stat-row",
            Self::TwoCol => "two-col",
            Self::Quote => "quote",
            Self::Section => "section",
            Self::ImageLeft => "image-left",
            Self::Chart => "chart",
            Self::Custom => "custom",
        }
    }

    /// Whether this layout takes `field`.
    pub fn uses(self, field: &str) -> bool {
        use Layout::*;
        match field {
            "kicker" => matches!(self, Title | Section | Bullets | TwoCol | StatRow | Chart),
            "headline" => !matches!(self, Quote | Custom),
            "sub" => matches!(self, Title | Statement),
            "body" => self == ImageLeft,
            "bullets" => matches!(self, Bullets | ImageLeft),
            "stats" => self == StatRow,
            "columns" => self == TwoCol,
            "quote" | "cite" => self == Quote,
            "chart" | "svg" => matches!(self, Chart | ImageLeft),
            "footnote" => !matches!(self, Title | Section | Custom),
            "html" => self == Custom,
            _ => false,
        }
    }

    /// The fields to name when the model sent html for this layout.
    fn main_fields(self) -> &'static str {
        match self {
            Self::Title => "headline and sub",
            Self::Statement => "headline",
            Self::Bullets => "headline and bullets",
            Self::StatRow => "headline and stats",
            Self::TwoCol => "headline and columns",
            Self::Quote => "quote and cite",
            Self::Section => "kicker and headline",
            Self::ImageLeft => "headline, body or bullets, and chart or svg",
            Self::Chart => "headline and chart (or svg)",
            Self::Custom => "html",
        }
    }

    fn headline_words(self) -> usize {
        match self {
            Self::Statement => 14,
            Self::Section => 8,
            Self::Chart => 12,
            _ => 10,
        }
    }

    /// (min items, max items, words per item) for `bullets`.
    fn bullet_rules(self) -> (usize, usize, usize) {
        match self {
            Self::ImageLeft => (2, 3, 12),
            _ => (2, 5, 14),
        }
    }

    /// The box a drawn chart fills, and the box a model's svg is checked in.
    fn picture_boxes(self) -> (PictureBox, PictureBox) {
        match self {
            Self::ImageLeft => (
                slide_charts::IMAGE_LEFT_BOX,
                slide_charts::IMAGE_LEFT_SVG_BOX,
            ),
            _ => (slide_charts::CHART_BOX, slide_charts::CHART_BOX),
        }
    }
}

/// The error for a layout name that is not one of the typed layouts.
pub fn unknown_layout(name: &str) -> String {
    format!(
        "layout \"{name}\" is not a layout; use one of {}.",
        LAYOUT_NAMES.join(", ")
    )
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/// A number the model sent where text was expected becomes its text.
fn text_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match Value::deserialize(d)? {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        Value::Null => Ok(String::new()),
        other => Err(serde::de::Error::custom(format!(
            "expected text, found {other}"
        ))),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Stat {
    #[serde(default, deserialize_with = "text_or_number")]
    pub value: String,
    #[serde(default, deserialize_with = "text_or_number")]
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Column {
    #[serde(default, deserialize_with = "text_or_number")]
    pub kicker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bullets: Option<Vec<String>>,
}

/// A slide's fields. Text fields hold inline HTML (text plus the slot tags).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SlideFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kicker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bullets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Vec<Stat>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<Column>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cite: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub svg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footnote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

fn present(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

impl SlideFields {
    /// The names of the fields that hold something (blank text and empty
    /// lists count as absent).
    pub fn present_names(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        let text = [
            ("kicker", &self.kicker),
            ("headline", &self.headline),
            ("sub", &self.sub),
            ("body", &self.body),
            ("quote", &self.quote),
            ("cite", &self.cite),
            ("svg", &self.svg),
            ("footnote", &self.footnote),
            ("html", &self.html),
        ];
        for name in FIELD_NAMES {
            let here = match name {
                "bullets" => self.bullets.as_ref().is_some_and(|b| !b.is_empty()),
                "stats" => self.stats.as_ref().is_some_and(|b| !b.is_empty()),
                "columns" => self.columns.as_ref().is_some_and(|b| !b.is_empty()),
                "chart" => self.chart.as_ref().is_some_and(|c| !c.is_null()),
                _ => text
                    .iter()
                    .find(|(n, _)| *n == name)
                    .is_some_and(|(_, v)| present(v).is_some()),
            };
            if here {
                out.push(name);
            }
        }
        out
    }
}

/// "a", "a or b", "a, b or c".
fn or_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ---------------------------------------------------------------------------
// Inline text
// ---------------------------------------------------------------------------

fn is_entity_at(s: &str, at: usize) -> bool {
    let bytes = s.as_bytes();
    let mut j = at + 1;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'#') {
        j += 1;
    }
    j > at + 1 && j < bytes.len() && bytes[j] == b';' && j - at <= 10
}

/// Check a text field (the slot inline subset) and escape its text: `< > "`
/// and any `&` that does not start an entity. Idempotent.
pub fn normalize_inline(text: &str) -> Result<String, String> {
    let text = text.trim();
    slide_html::validate_inline(text)?;
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let escape = |seg: &str, out: &mut String| {
        for (i, c) in seg.char_indices() {
            match c {
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '&' if !is_entity_at(seg, i) => out.push_str("&amp;"),
                other => out.push(other),
            }
        }
    };
    for tok in slide_html::scan(text) {
        escape(&text[at..tok.range.start], &mut out);
        out.push_str(&text[tok.range.clone()]);
        at = tok.range.end;
    }
    escape(&text[at..], &mut out);
    Ok(out)
}

fn visible(inline: &str) -> String {
    slide_visible_text(inline)
}

fn words(inline: &str) -> usize {
    visible(inline).split_whitespace().count()
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

struct Check {
    errors: Vec<String>,
}

impl Check {
    fn push(&mut self, msg: String) {
        self.errors.push(msg);
    }

    /// Normalize one text value and hold it to `max` words.
    fn text(&mut self, path: &str, value: &str, max: usize) -> Option<String> {
        match normalize_inline(value) {
            Ok(norm) => {
                let n = words(&norm);
                if n > max {
                    self.push(format!(
                        "{path} is {}; at most {max} — shorten it.",
                        plural(n, "word", "words")
                    ));
                }
                Some(norm)
            }
            Err(e) => {
                self.push(format!("{path}: {e}"));
                None
            }
        }
    }

    /// A list of bullet texts: `min..=max` items of at most `item_words`.
    fn bullets(
        &mut self,
        path: &str,
        items: &[String],
        (min, max, item_words): (usize, usize, usize),
        too_few_hint: &str,
    ) -> Vec<String> {
        let items: Vec<&String> = items.iter().filter(|b| !b.trim().is_empty()).collect();
        let count = items.len();
        if count > max {
            self.push(format!(
                "{path} has {}; at most {max} — split the slide.",
                plural(count, "item", "items")
            ));
        } else if count < min {
            self.push(format!(
                "{path} has {}; at least {min} — {too_few_hint}.",
                plural(count, "item", "items")
            ));
        }
        items
            .iter()
            .enumerate()
            .filter_map(|(i, b)| self.text(&format!("{path}[{i}]"), b, item_words))
            .collect()
    }
}

/// Check a layout's fields against its budgets and return them normalized:
/// text escaped, svg cleaned, chart spec canonical, blanks dropped. Every
/// problem is reported in one message, one sentence each.
pub fn validate(layout: Layout, fields: &SlideFields) -> Result<SlideFields, String> {
    let mut c = Check { errors: Vec::new() };
    let given = fields.present_names();
    let name = layout.name();

    if layout == Layout::Custom {
        let unused: Vec<&str> = given.iter().copied().filter(|f| *f != "html").collect();
        if !unused.is_empty() {
            c.push(format!(
                "custom does not use {} — put everything in html.",
                or_list(&unused)
            ));
        }
        let html = present_html(fields);
        if html.is_none() {
            c.push("html is required for layout custom.".to_string());
        }
        return if c.errors.is_empty() {
            Ok(SlideFields {
                html: html.map(str::to_string),
                ..Default::default()
            })
        } else {
            Err(c.errors.join(" "))
        };
    }
    if given.contains(&"html") {
        return Err(format!(
            "html is only for layout custom; for {name} pass {}.",
            layout.main_fields()
        ));
    }
    let unused: Vec<&str> = given.iter().copied().filter(|f| !layout.uses(f)).collect();
    if !unused.is_empty() {
        c.push(format!(
            "{name} does not use {} — leave {} out.",
            or_list(&unused),
            if unused.len() == 1 { "it" } else { "them" }
        ));
    }
    let uses = |f: &str| layout.uses(f) && given.contains(&f);
    let mut out = SlideFields::default();

    // Single text fields.
    if uses("kicker") {
        out.kicker = c.text(
            "kicker",
            present(&fields.kicker).unwrap_or(""),
            KICKER_WORDS,
        );
    }
    if uses("headline") {
        out.headline = c.text(
            "headline",
            present(&fields.headline).unwrap_or(""),
            layout.headline_words(),
        );
    } else if layout.uses("headline") && layout != Layout::StatRow {
        c.push(format!("headline is required for layout {name}."));
    }
    if uses("sub") {
        out.sub = c.text("sub", present(&fields.sub).unwrap_or(""), SUB_WORDS);
    }
    if uses("body") {
        out.body = c.text("body", present(&fields.body).unwrap_or(""), BODY_WORDS);
    }
    if uses("quote") {
        out.quote = c.text("quote", present(&fields.quote).unwrap_or(""), QUOTE_WORDS);
    } else if layout == Layout::Quote {
        c.push("quote is required for layout quote.".to_string());
    }
    if uses("cite") {
        out.cite = c.text("cite", present(&fields.cite).unwrap_or(""), CITE_WORDS);
    }

    // Bullets.
    if uses("bullets") {
        let hint = if layout == Layout::ImageLeft {
            "add a point or use body"
        } else {
            "add a point or use layout statement"
        };
        out.bullets = Some(c.bullets(
            "bullets",
            fields.bullets.as_deref().unwrap_or(&[]),
            layout.bullet_rules(),
            hint,
        ));
    } else if layout == Layout::Bullets {
        c.push("bullets is required for layout bullets.".to_string());
    }
    if layout == Layout::ImageLeft {
        match (uses("body"), uses("bullets")) {
            (false, false) => c.push("image-left needs body or bullets.".to_string()),
            (true, true) => {
                c.push("image-left takes body or bullets, not both — pick one.".to_string())
            }
            _ => {}
        }
    }

    // Stats.
    if uses("stats") {
        let stats = fields.stats.as_deref().unwrap_or(&[]);
        let count = stats.len();
        if count > 4 {
            c.push(format!(
                "stats has {count} items; at most 4 — keep the strongest or split the slide."
            ));
        } else if count < 2 {
            c.push(format!(
                "stats has {}; at least 2 — add a figure, or use layout statement for one number.",
                plural(count, "item", "items")
            ));
        }
        let mut norm = Vec::new();
        for (i, stat) in stats.iter().enumerate() {
            let value = stat.value.trim();
            let label = stat.label.trim();
            let mut v = None;
            if value.is_empty() {
                c.push(format!("stats[{i}].value is required."));
            } else {
                match normalize_inline(value) {
                    Ok(nv) => {
                        let shown = visible(&nv);
                        let chars = shown.chars().count();
                        if chars > STAT_VALUE_CHARS {
                            c.push(format!(
                                "stats[{i}].value \"{shown}\" is {chars} characters; at most {STAT_VALUE_CHARS} — put the unit or context in the label."
                            ));
                        }
                        v = Some(nv);
                    }
                    Err(e) => c.push(format!("stats[{i}].value: {e}")),
                }
            }
            let l = if label.is_empty() {
                c.push(format!("stats[{i}].label is required."));
                None
            } else {
                c.text(&format!("stats[{i}].label"), label, STAT_LABEL_WORDS)
            };
            norm.push(Stat {
                value: v.unwrap_or_default(),
                label: l.unwrap_or_default(),
            });
        }
        out.stats = Some(norm);
    } else if layout == Layout::StatRow {
        c.push("stats is required for layout stat-row.".to_string());
    }

    // Columns.
    if uses("columns") {
        let cols = fields.columns.as_deref().unwrap_or(&[]);
        if cols.len() != 2 {
            c.push(format!(
                "columns has {}; two-col needs exactly 2.",
                plural(cols.len(), "item", "items")
            ));
        }
        let mut norm = Vec::new();
        for (i, col) in cols.iter().enumerate() {
            let path = format!("columns[{i}]");
            let kicker = if col.kicker.trim().is_empty() {
                c.push(format!("{path}.kicker is required."));
                String::new()
            } else {
                c.text(&format!("{path}.kicker"), &col.kicker, COLUMN_KICKER_WORDS)
                    .unwrap_or_default()
            };
            let body = present(&col.body);
            let bullets = col
                .bullets
                .as_ref()
                .filter(|b| b.iter().any(|x| !x.trim().is_empty()));
            let mut out_col = Column {
                kicker,
                ..Default::default()
            };
            match (body, bullets) {
                (None, None) => c.push(format!("{path} needs body or bullets.")),
                (Some(_), Some(_)) => c.push(format!(
                    "{path} takes body or bullets, not both — pick one."
                )),
                (Some(b), None) => {
                    out_col.body = c.text(&format!("{path}.body"), b, COLUMN_BODY_WORDS);
                }
                (None, Some(items)) => {
                    out_col.bullets = Some(c.bullets(
                        &format!("{path}.bullets"),
                        items,
                        (2, 4, 10),
                        "add a point or use body",
                    ));
                }
            }
            norm.push(out_col);
        }
        out.columns = Some(norm);
    } else if layout == Layout::TwoCol {
        c.push("columns is required for layout two-col.".to_string());
    }

    // Picture.
    if layout.uses("chart") {
        let (chart_box, svg_box) = layout.picture_boxes();
        match (uses("chart"), uses("svg")) {
            (false, false) => c.push(format!(
                "{name} needs chart (data the app draws) or svg (your own drawing)."
            )),
            (true, true) => c.push(format!(
                "{name} takes chart or svg, not both — use chart for data, svg for a diagram."
            )),
            (true, false) => {
                let value = fields.chart.as_ref().unwrap_or(&Value::Null);
                match slide_charts::parse_spec(value) {
                    Ok(spec) => match slide_charts::render(&spec, chart_box) {
                        Ok(_) => out.chart = serde_json::to_value(&spec).ok(),
                        Err(errs) => c.errors.extend(errs),
                    },
                    Err(errs) => c.errors.extend(errs),
                }
            }
            (false, true) => {
                match slide_charts::check_svg(present(&fields.svg).unwrap_or(""), svg_box) {
                    Ok(svg) => out.svg = Some(svg),
                    Err(errs) => c.errors.extend(errs),
                }
            }
        }
    }

    if uses("footnote") {
        out.footnote = c.text(
            "footnote",
            present(&fields.footnote).unwrap_or(""),
            FOOTNOTE_WORDS,
        );
    }

    if c.errors.is_empty() {
        Ok(out)
    } else {
        Err(c.errors.join(" "))
    }
}

fn present_html(fields: &SlideFields) -> Option<&str> {
    present(&fields.html)
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

fn el(tag: &str, class: Option<&str>, slot: &str, inner: &str) -> String {
    match class {
        Some(class) => format!("<{tag} class=\"{class}\" data-text=\"{slot}\">{inner}</{tag}>"),
        None => format!("<{tag} data-text=\"{slot}\">{inner}</{tag}>"),
    }
}

fn bullet_list(prefix: &str, items: &[String]) -> String {
    let lis: String = items
        .iter()
        .enumerate()
        .map(|(i, b)| el("li", None, &format!("{prefix}{}", i + 1), b))
        .collect();
    format!("<ul class=\"bullets\">{lis}</ul>")
}

fn picture(layout: Layout, fields: &SlideFields) -> Result<Option<String>, String> {
    if let Some(chart) = &fields.chart {
        let spec = slide_charts::parse_spec(chart).map_err(|e| e.join(" "))?;
        let (chart_box, _) = layout.picture_boxes();
        return slide_charts::render(&spec, chart_box)
            .map(Some)
            .map_err(|e| e.join(" "));
    }
    Ok(fields.svg.clone())
}

/// Build a slide's inner HTML from fields that passed [`validate`] (or were
/// read back from a built slide). Fields the layout does not use are ignored.
pub fn render(layout: Layout, f: &SlideFields) -> Result<String, String> {
    if layout == Layout::Custom {
        return Ok(f.html.clone().unwrap_or_default());
    }
    let mut parts: Vec<String> = Vec::new();
    let heading = if matches!(layout, Layout::Title | Layout::Statement | Layout::Section) {
        "h1"
    } else {
        "h2"
    };
    if layout == Layout::ImageLeft {
        if let Some(svg) = picture(layout, f)? {
            parts.push(svg);
        }
    }
    if layout.uses("kicker") {
        if let Some(k) = &f.kicker {
            parts.push(el("p", Some("kicker"), "kicker", k));
        }
    }
    if layout.uses("headline") {
        if let Some(h) = &f.headline {
            parts.push(el(heading, Some("headline"), "headline", h));
        }
    }
    if layout.uses("sub") {
        if let Some(s) = &f.sub {
            parts.push(el("p", Some("sub"), "sub", s));
        }
    }
    if layout == Layout::Quote {
        if let Some(q) = &f.quote {
            parts.push(el("blockquote", Some("quote"), "quote", q));
        }
        if let Some(cite) = &f.cite {
            parts.push(el("p", Some("cite"), "cite", cite));
        }
    }
    if layout.uses("body") {
        if let Some(b) = &f.body {
            parts.push(el("p", Some("body"), "body", b));
        }
    }
    if layout.uses("bullets") {
        if let Some(items) = &f.bullets {
            parts.push(bullet_list("bullet-", items));
        }
    }
    if layout.uses("stats") {
        if let Some(stats) = &f.stats {
            let inner: String = stats
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    format!(
                        "<div class=\"stat\">{}{}</div>",
                        el("b", None, &format!("stat-{}-value", i + 1), &s.value),
                        el("span", None, &format!("stat-{}-label", i + 1), &s.label)
                    )
                })
                .collect();
            parts.push(format!("<div class=\"stats\">{inner}</div>"));
        }
    }
    if layout.uses("columns") {
        for (i, col) in f.columns.iter().flatten().enumerate() {
            let n = i + 1;
            let mut inner = el("p", Some("kicker"), &format!("col-{n}-kicker"), &col.kicker);
            if let Some(body) = &col.body {
                inner.push_str(&el("p", Some("body"), &format!("col-{n}-body"), body));
            }
            if let Some(items) = &col.bullets {
                inner.push_str(&bullet_list(&format!("col-{n}-bullet-"), items));
            }
            parts.push(format!("<div class=\"col\">{inner}</div>"));
        }
    }
    if layout == Layout::Chart {
        if let Some(svg) = picture(layout, f)? {
            parts.push(svg);
        }
    }
    if layout.uses("footnote") {
        if let Some(note) = &f.footnote {
            parts.push(el("p", Some("footnote"), "footnote", note));
        }
    }
    Ok(parts.join("\n"))
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/// `html` with every slot's `data-owner` marker removed.
fn strip_owner_markers(html: &str) -> String {
    let mut out = html.to_string();
    let mut pinned: Vec<_> = slide_html::slots(html)
        .into_iter()
        .filter(|s| s.pinned)
        .map(|s| s.outer_open_tag)
        .collect();
    pinned.sort_by_key(|r| std::cmp::Reverse(r.start));
    for range in pinned {
        slide_html::unpin_tag(&mut out, range);
    }
    out
}

/// The first `<svg>` element of `html`, start tag through end tag.
fn first_svg(html: &str) -> Option<&str> {
    let toks = slide_html::scan(html);
    let start = toks.iter().position(
        |t| matches!(&t.kind, TokKind::Open { name, self_closing: false } if name == "svg"),
    )?;
    let mut depth = 0usize;
    for tok in &toks[start..] {
        match &tok.kind {
            TokKind::Open {
                name,
                self_closing: false,
            } if name == "svg" => depth += 1,
            TokKind::Close { name } if name == "svg" => {
                depth -= 1;
                if depth == 0 {
                    return Some(&html[toks[start].range.start..tok.range.end]);
                }
            }
            _ => {}
        }
    }
    None
}

/// The fields of a slide the builder made, read back from its slots (and its
/// chart's `data-chart`). `None` for custom slides, for layouts that are not
/// typed, and for slides whose HTML is not exactly what the builder would
/// make from those fields (hand-written or hand-edited markup).
pub fn reconstruct(layout_name: &str, html: &str) -> Option<SlideFields> {
    let layout = Layout::parse(layout_name)?;
    if layout == Layout::Custom {
        return None;
    }
    let slots = slide_html::slots(html);
    let mut map: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for slot in &slots {
        if map
            .insert(slot.name.as_str(), &html[slot.inner.clone()])
            .is_some()
        {
            return None;
        }
    }
    let get = |name: &str| map.get(name).map(|s| (*s).to_string());
    let numbered = |prefix: &str| -> Vec<String> {
        (1..)
            .map_while(|i| {
                map.get(format!("{prefix}{i}").as_str())
                    .map(|s| (*s).to_string())
            })
            .collect()
    };
    let mut f = SlideFields::default();
    if layout.uses("kicker") {
        f.kicker = get("kicker");
    }
    if layout.uses("headline") {
        f.headline = get("headline");
    }
    if layout.uses("sub") {
        f.sub = get("sub");
    }
    if layout.uses("body") {
        f.body = get("body");
    }
    if layout.uses("quote") {
        f.quote = get("quote");
        f.cite = get("cite");
    }
    if layout.uses("footnote") {
        f.footnote = get("footnote");
    }
    if layout.uses("bullets") {
        let items = numbered("bullet-");
        if !items.is_empty() {
            f.bullets = Some(items);
        }
    }
    if layout.uses("stats") {
        let stats: Vec<Stat> = (1..)
            .map_while(|i| {
                Some(Stat {
                    value: get(&format!("stat-{i}-value"))?,
                    label: get(&format!("stat-{i}-label"))?,
                })
            })
            .collect();
        if !stats.is_empty() {
            f.stats = Some(stats);
        }
    }
    if layout.uses("columns") {
        let cols: Vec<Column> = (1..)
            .map_while(|i| {
                let kicker = get(&format!("col-{i}-kicker"))?;
                let bullets = numbered(&format!("col-{i}-bullet-"));
                Some(Column {
                    kicker,
                    body: get(&format!("col-{i}-body")),
                    bullets: (!bullets.is_empty()).then_some(bullets),
                })
            })
            .collect();
        if !cols.is_empty() {
            f.columns = Some(cols);
        }
    }
    if layout.uses("chart") {
        if let Some(svg) = first_svg(html) {
            match slide_charts::stored_spec(svg) {
                Some(spec) => f.chart = serde_json::to_value(spec).ok(),
                None => f.svg = Some(svg.to_string()),
            }
        }
    }
    let rebuilt = render(layout, &f).ok()?;
    (rebuilt == strip_owner_markers(html)).then_some(f)
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/// Merge `changes` (field name to value, as the model sent them) onto `base`.
/// Only fields `target` uses carry over from `base`; a `null`, blank string or
/// empty list in `changes` removes the field.
pub fn merge_fields(
    base: &SlideFields,
    target: Layout,
    changes: &Map<String, Value>,
) -> Result<SlideFields, String> {
    let mut map = match serde_json::to_value(base) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.retain(|k, _| target.uses(k));
    for (key, value) in changes {
        let empty = match value {
            Value::Null => true,
            Value::String(s) => s.trim().is_empty(),
            Value::Array(a) => a.is_empty(),
            _ => false,
        };
        if empty {
            map.remove(key);
        } else {
            map.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(Value::Object(map))
        .map_err(|e| format!("The slide fields are not valid: {e}."))
}

/// Carry every pinned slot of `old` (except those in `released`) into `new` by
/// name and occurrence: its content and its marker. A pinned slot whose name
/// `new` does not have is an error.
pub fn carry_pinned(
    old: &str,
    new: &str,
    released: &[String],
    layout: &str,
) -> Result<String, String> {
    let old_slots = slide_html::slots(old);
    let mut out = new.to_string();
    let mut missing: Vec<String> = Vec::new();
    for (pos, slot) in old_slots.iter().enumerate() {
        if !slot.pinned || released.iter().any(|r| r == &slot.name) {
            continue;
        }
        let occurrence = old_slots[..pos]
            .iter()
            .filter(|s| s.name == slot.name)
            .count();
        let target = slide_html::slots(&out)
            .into_iter()
            .filter(|s| s.name == slot.name)
            .nth(occurrence);
        match target {
            Some(t) => {
                // The content sits after the start tag: replace it first so
                // the start tag's range stays valid for the marker.
                out.replace_range(t.inner.clone(), &old[slot.inner.clone()]);
                slide_html::pin_tag(&mut out, t.outer_open_tag);
            }
            None => {
                if !missing.contains(&slot.name) {
                    missing.push(slot.name.clone());
                }
            }
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    let quoted: Vec<String> = missing.iter().map(|m| format!("\"{m}\"")).collect();
    Err(if missing.len() == 1 {
        format!(
            "Slot {} is pinned (the user wrote it) and layout {layout} has no slot by that name — keep the layout, or pass release_pinned: [{}] only if the user asked to change that text.",
            quoted[0], quoted[0]
        )
    } else {
        format!(
            "Slots {} are pinned (the user wrote them) and layout {layout} has no slots by those names — keep the layout, or pass release_pinned: [{}] only if the user asked to change that text.",
            quoted.join(", "),
            quoted.join(", ")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(v: Value) -> SlideFields {
        serde_json::from_value(v).unwrap()
    }

    fn build(layout: &str, v: Value) -> String {
        let layout = Layout::parse(layout).unwrap();
        let f = validate(layout, &fields(v)).unwrap();
        render(layout, &f).unwrap()
    }

    fn err(layout: &str, v: Value) -> String {
        validate(Layout::parse(layout).unwrap(), &fields(v)).unwrap_err()
    }

    fn slot_names(html: &str) -> Vec<String> {
        slide_html::slots(html)
            .into_iter()
            .map(|s| s.name)
            .collect()
    }

    const BAR: &str = r#"{ "type": "bar", "categories": ["Q1", "Q2", "Q3"], "series": [{ "name": "Revenue", "values": [3, 5, 8] }] }"#;

    fn bar() -> Value {
        serde_json::from_str(BAR).unwrap()
    }

    #[test]
    fn every_layout_builds_its_slots_and_classes() {
        let title = build(
            "title",
            json!({ "kicker": "Q3 review", "headline": "We grew", "sub": "And kept margins" }),
        );
        assert_eq!(
            title,
            "<p class=\"kicker\" data-text=\"kicker\">Q3 review</p>\n<h1 class=\"headline\" data-text=\"headline\">We grew</h1>\n<p class=\"sub\" data-text=\"sub\">And kept margins</p>"
        );
        let statement = build(
            "statement",
            json!({ "headline": "Ship less, better", "footnote": "Source: us" }),
        );
        assert_eq!(slot_names(&statement), ["headline", "footnote"]);
        assert!(statement.contains("<p class=\"footnote\" data-text=\"footnote\">"));

        let bullets = build(
            "bullets",
            json!({ "headline": "Why now", "bullets": ["One", "Two", "Three"] }),
        );
        assert_eq!(
            slot_names(&bullets),
            ["headline", "bullet-1", "bullet-2", "bullet-3"]
        );
        assert!(bullets.contains("<ul class=\"bullets\"><li data-text=\"bullet-1\">One</li>"));

        let stats = build(
            "stat-row",
            json!({ "stats": [{ "value": "42%", "label": "faster" }, { "value": 7, "label": "teams" }] }),
        );
        assert_eq!(
            slot_names(&stats),
            [
                "stat-1-value",
                "stat-1-label",
                "stat-2-value",
                "stat-2-label"
            ]
        );
        assert!(stats.contains("<div class=\"stats\"><div class=\"stat\"><b data-text=\"stat-1-value\">42%</b><span data-text=\"stat-1-label\">faster</span></div>"));
        assert!(stats.contains(">7</b>"), "a number value becomes text");

        let cols = build(
            "two-col",
            json!({ "headline": "Before and after", "columns": [
            { "kicker": "Before", "body": "Slow builds" },
            { "kicker": "After", "bullets": ["Fast", "Cheap"] }
        ] }),
        );
        assert_eq!(
            slot_names(&cols),
            [
                "headline",
                "col-1-kicker",
                "col-1-body",
                "col-2-kicker",
                "col-2-bullet-1",
                "col-2-bullet-2"
            ]
        );
        assert!(cols.contains("<div class=\"col\"><p class=\"kicker\" data-text=\"col-1-kicker\">Before</p><p class=\"body\" data-text=\"col-1-body\">Slow builds</p></div>"));

        let quote = build(
            "quote",
            json!({ "quote": "Make it simple", "cite": "A. Person" }),
        );
        assert_eq!(
            quote,
            "<blockquote class=\"quote\" data-text=\"quote\">Make it simple</blockquote>\n<p class=\"cite\" data-text=\"cite\">A. Person</p>"
        );
        let section = build(
            "section",
            json!({ "kicker": "Part 2", "headline": "The plan" }),
        );
        assert_eq!(slot_names(&section), ["kicker", "headline"]);

        let image = build(
            "image-left",
            json!({ "headline": "Our reach", "body": "Two regions", "chart": bar() }),
        );
        assert!(
            image.starts_with("<svg "),
            "the picture comes first: {image}"
        );
        assert!(image.contains("viewBox=\"0 0 820 600\""));
        assert_eq!(slot_names(&image), ["headline", "body"]);

        let chart = build(
            "chart",
            json!({ "kicker": "Revenue", "headline": "Up and to the right", "chart": bar(), "footnote": "FY25" }),
        );
        assert_eq!(slot_names(&chart), ["kicker", "headline", "footnote"]);
        assert!(chart.contains("viewBox=\"0 0 1680 640\"") && chart.contains("data-chart="));

        let custom = build("custom", json!({ "html": "<p data-text=\"x\">Hi</p>" }));
        assert_eq!(custom, "<p data-text=\"x\">Hi</p>");
    }

    #[test]
    fn text_is_checked_and_escaped() {
        let html = build(
            "statement",
            json!({ "headline": "R&D <em>beats</em> a < b & \"c\" &amp; d" }),
        );
        assert!(
            html.contains(">R&amp;D <em>beats</em> a &lt; b &amp; &quot;c&quot; &amp; d<"),
            "{html}"
        );
        assert_eq!(normalize_inline("a &amp; b").unwrap(), "a &amp; b");
        let e = err("statement", json!({ "headline": "<div>x</div>" }));
        assert!(
            e.starts_with("headline: Slot text can only use these tags"),
            "{e}"
        );
    }

    #[test]
    fn every_budget_rule_has_an_error() {
        let long = |n: usize| vec!["word"; n].join(" ");
        let cases: Vec<(&str, Value, &str)> = vec![
            ("title", json!({ "headline": long(11) }), "headline is 11 words; at most 10 — shorten it."),
            ("title", json!({ "headline": "x", "sub": long(21) }), "sub is 21 words; at most 20"),
            ("title", json!({ "headline": "x", "kicker": long(5) }), "kicker is 5 words; at most 4"),
            ("statement", json!({ "headline": long(15) }), "headline is 15 words; at most 14"),
            ("bullets", json!({ "headline": "x", "bullets": vec!["a"; 7] }), "bullets has 7 items; at most 5 — split the slide."),
            ("bullets", json!({ "headline": "x", "bullets": ["a"] }), "bullets has 1 item; at least 2"),
            ("bullets", json!({ "headline": "x", "bullets": ["a", long(15)] }), "bullets[1] is 15 words; at most 14"),
            ("stat-row", json!({ "headline": long(11), "stats": [{ "value": "1", "label": "a" }, { "value": "2", "label": "b" }] }), "headline is 11 words"),
            ("stat-row", json!({ "stats": [{ "value": "1", "label": "a" }] }), "stats has 1 item; at least 2"),
            ("stat-row", json!({ "stats": vec![json!({ "value": "1", "label": "a" }); 5] }), "stats has 5 items; at most 4"),
            ("stat-row", json!({ "stats": [{ "value": "1", "label": "a" }, { "value": "16 B/param", "label": "b" }] }), "stats[1].value \"16 B/param\" is 10 characters; at most 6 — put the unit or context in the label."),
            ("stat-row", json!({ "stats": [{ "value": "1", "label": long(9) }, { "value": "2", "label": "b" }] }), "stats[0].label is 9 words; at most 8"),
            ("stat-row", json!({ "stats": [{ "value": "1", "label": "a" }, { "value": "2", "label": "b" }], "footnote": long(21) }), "footnote is 21 words; at most 20"),
            ("two-col", json!({ "headline": long(11), "columns": [{ "kicker": "a", "body": "x" }, { "kicker": "b", "body": "y" }] }), "headline is 11 words"),
            ("two-col", json!({ "headline": "x", "columns": [{ "kicker": "a", "body": "x" }] }), "columns has 1 item; two-col needs exactly 2."),
            ("two-col", json!({ "headline": "x", "columns": [{ "kicker": long(5), "body": "x" }, { "kicker": "b", "body": "y" }] }), "columns[0].kicker is 5 words; at most 4"),
            ("two-col", json!({ "headline": "x", "columns": [{ "kicker": "a", "body": long(31) }, { "kicker": "b", "body": "y" }] }), "columns[0].body is 31 words; at most 30"),
            ("two-col", json!({ "headline": "x", "columns": [{ "kicker": "a", "bullets": vec!["x"; 5] }, { "kicker": "b", "body": "y" }] }), "columns[0].bullets has 5 items; at most 4"),
            ("two-col", json!({ "headline": "x", "columns": [{ "kicker": "a", "bullets": ["x", long(11)] }, { "kicker": "b", "body": "y" }] }), "columns[0].bullets[1] is 11 words; at most 10"),
            ("two-col", json!({ "headline": "x", "columns": [{ "kicker": "a" }, { "kicker": "b", "body": "y", "bullets": ["p", "q"] }] }), "columns[0] needs body or bullets. columns[1] takes body or bullets, not both"),
            ("quote", json!({ "quote": long(31) }), "quote is 31 words; at most 30"),
            ("quote", json!({ "quote": "x", "cite": long(9) }), "cite is 9 words; at most 8"),
            ("section", json!({ "headline": long(9) }), "headline is 9 words; at most 8"),
            ("section", json!({ "headline": "x", "kicker": long(5) }), "kicker is 5 words; at most 4"),
            ("image-left", json!({ "headline": long(11), "body": "x", "chart": bar() }), "headline is 11 words"),
            ("image-left", json!({ "headline": "x", "body": long(31), "chart": bar() }), "body is 31 words; at most 30"),
            ("image-left", json!({ "headline": "x", "bullets": vec!["a"; 4], "chart": bar() }), "bullets has 4 items; at most 3"),
            ("image-left", json!({ "headline": "x", "bullets": ["a", long(13)], "chart": bar() }), "bullets[1] is 13 words; at most 12"),
            ("image-left", json!({ "headline": "x", "chart": bar() }), "image-left needs body or bullets."),
            ("image-left", json!({ "headline": "x", "body": "y" }), "image-left needs chart (data the app draws) or svg"),
            ("chart", json!({ "headline": long(13), "chart": bar() }), "headline is 13 words; at most 12"),
            ("chart", json!({ "headline": "x", "chart": bar(), "svg": "<svg viewBox=\"0 0 1 1\"></svg>" }), "chart takes chart or svg, not both"),
            ("chart", json!({ "headline": "x", "chart": bar(), "footnote": long(21) }), "footnote is 21 words; at most 20"),
            ("custom", json!({ "headline": "x" }), "custom does not use headline — put everything in html. html is required for layout custom."),
        ];
        for (layout, value, expected) in cases {
            let e = err(layout, value.clone());
            assert!(
                e.contains(expected),
                "{layout} {value}: got {e:?}, expected {expected:?}"
            );
        }
    }

    #[test]
    fn all_violations_come_in_one_message() {
        let e = err(
            "stat-row",
            json!({
                "stats": [{ "value": "16 B/param", "label": "memory" }, { "value": "1", "label": "x" }, { "value": "2", "label": "y" }, { "value": "3", "label": "z" }, { "value": "4", "label": "w" }],
                "bullets": ["a", "b"],
                "sub": "s",
            }),
        );
        assert_eq!(
            e,
            "stat-row does not use sub or bullets — leave them out. stats has 5 items; at most 4 — keep the strongest or split the slide. stats[0].value \"16 B/param\" is 10 characters; at most 6 — put the unit or context in the label."
        );
        let e = err("bullets", json!({}));
        assert_eq!(
            e,
            "headline is required for layout bullets. bullets is required for layout bullets."
        );
    }

    #[test]
    fn html_on_a_typed_layout_is_refused() {
        assert_eq!(
            err("stat-row", json!({ "html": "<p>x</p>", "headline": "y" })),
            "html is only for layout custom; for stat-row pass headline and stats."
        );
        // An empty html is just absent.
        assert!(validate(
            Layout::Bullets,
            &fields(json!({ "html": "", "headline": "x", "bullets": ["a", "b"] }))
        )
        .is_ok());
    }

    #[test]
    fn svg_field_follows_the_svg_rules() {
        let html = build(
            "chart",
            json!({ "headline": "Flow", "svg": "<svg width=\"10\" viewBox=\"0 0 1680 640\" data-chart=\"{}\"><text font-size=\"30\">A</text></svg>" }),
        );
        assert!(
            html.contains("<svg viewBox=\"0 0 1680 640\"><text font-size=\"30\">A</text></svg>"),
            "{html}"
        );
        let e = err(
            "image-left",
            json!({ "headline": "x", "body": "y", "svg": "<svg viewBox=\"0 0 1640 600\"><text font-size=\"22\">t</text></svg>" }),
        );
        assert!(e.contains("renders at 11px"), "{e}");
    }

    #[test]
    fn built_slides_read_back_into_their_fields() {
        let cases = [
            (
                "title",
                json!({ "kicker": "K", "headline": "H <em>x</em>", "sub": "S" }),
            ),
            (
                "bullets",
                json!({ "headline": "H", "bullets": ["a", "b & c"], "footnote": "F" }),
            ),
            (
                "stat-row",
                json!({ "stats": [{ "value": "1", "label": "a" }, { "value": "2", "label": "b" }] }),
            ),
            (
                "two-col",
                json!({ "headline": "H", "columns": [{ "kicker": "A", "body": "x" }, { "kicker": "B", "bullets": ["p", "q"] }] }),
            ),
            ("quote", json!({ "quote": "Q", "cite": "C" })),
            (
                "image-left",
                json!({ "headline": "H", "bullets": ["a", "b"], "svg": "<svg viewBox=\"0 0 820 600\"><rect/></svg>" }),
            ),
            ("chart", json!({ "headline": "H", "chart": bar() })),
        ];
        for (layout, value) in cases {
            let l = Layout::parse(layout).unwrap();
            let f = validate(l, &fields(value)).unwrap();
            let html = render(l, &f).unwrap();
            assert_eq!(reconstruct(layout, &html), Some(f.clone()), "{layout}");
            // Pinned markers do not stop the read-back.
            let pinned = slide_html::set_pinned(&html, 0, &slot_names(&html)[0], true).unwrap();
            assert_eq!(reconstruct(layout, &pinned), Some(f), "{layout} pinned");
        }
        // Hand-written or hand-edited markup is not read back.
        assert_eq!(
            reconstruct("title", "<h1 data-text=\"headline\">H</h1>"),
            None
        );
        let html = build("bullets", json!({ "headline": "H", "bullets": ["a", "b"] }));
        assert_eq!(
            reconstruct(
                "bullets",
                &html.replace("class=\"bullets\"", "class=\"bullets big\"")
            ),
            None
        );
        assert_eq!(reconstruct("custom", "<p>x</p>"), None);
        assert_eq!(reconstruct("agenda", &html), None);
        // A slot cleared in the Script view still reads back.
        let cleared = html.replace(">a</li>", "></li>");
        assert!(reconstruct("bullets", &cleared).is_some());
    }

    #[test]
    fn merge_overlays_changes_and_removes_nulls() {
        let base = fields(json!({ "headline": "H", "sub": "S", "kicker": "K" }));
        let changes = json!({ "headline": "New", "sub": null, "kicker": "" });
        let merged = merge_fields(&base, Layout::Title, changes.as_object().unwrap()).unwrap();
        assert_eq!(merged, fields(json!({ "headline": "New" })));
        // A layout change carries only what the new layout uses.
        let base = fields(json!({ "headline": "H", "bullets": ["a", "b"], "footnote": "F" }));
        let changes =
            json!({ "stats": [{ "value": "1", "label": "x" }, { "value": "2", "label": "y" }] });
        let merged = merge_fields(&base, Layout::StatRow, changes.as_object().unwrap()).unwrap();
        assert_eq!(merged.headline.as_deref(), Some("H"));
        assert_eq!(merged.footnote.as_deref(), Some("F"));
        assert!(merged.bullets.is_none());
        assert!(validate(Layout::StatRow, &merged).is_ok());
    }

    #[test]
    fn pinned_slots_carry_over_by_name() {
        let old = build(
            "bullets",
            json!({ "headline": "Mine", "bullets": ["a", "b"] }),
        );
        let old = slide_html::set_pinned(&old, 0, "headline", true).unwrap();
        let new = build(
            "bullets",
            json!({ "headline": "Theirs", "bullets": ["c", "d"] }),
        );
        let carried = carry_pinned(&old, &new, &[], "bullets").unwrap();
        assert!(
            carried.contains(
                "<h2 class=\"headline\" data-text=\"headline\" data-owner=\"user\">Mine</h2>"
            ),
            "{carried}"
        );
        assert!(carried.contains(">c</li>"));
        // Released: the new text wins.
        let released = carry_pinned(&old, &new, &["headline".to_string()], "bullets").unwrap();
        assert_eq!(released, new);
        // A pinned slot the new layout lacks.
        let old = slide_html::set_pinned(&old, 1, "bullet-1", true).unwrap();
        let quote = build("quote", json!({ "quote": "Q" }));
        let e = carry_pinned(&old, &quote, &[], "quote").unwrap_err();
        assert!(
            e.starts_with("Slots \"headline\", \"bullet-1\" are pinned"),
            "{e}"
        );
        assert!(
            e.contains("release_pinned: [\"headline\", \"bullet-1\"]"),
            "{e}"
        );
    }
}
