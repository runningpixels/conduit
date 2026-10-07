//! Slide pictures: charts the app draws from a small data spec (bar, line,
//! funnel), and the rules a model-written `<svg>` must follow.
//!
//! A chart is rendered to an SVG string in the theme's tokens only, sized to
//! the box the theme gives the picture, with every label at least
//! [`MIN_FONT`] units. The spec is stored on the root as `data-chart` so the
//! chart can be read back and edited. Text widths are estimated (no font
//! metrics here), generously, so labels that would collide are rejected at
//! call time instead of overlapping on the slide.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::slide_html::{self, escape_text, TokKind};

/// The smallest font size the renderer uses, in viewBox units.
pub const MIN_FONT: f64 = 26.0;
/// Category, stage and value labels.
const LABEL_FONT: f64 = 28.0;
/// Estimated advance per character, in ems. Generous on purpose.
const CHAR_EM: f64 = 0.6;
const LINE_HEIGHT: f64 = 1.2;
/// Longest unit prefix or suffix, in characters.
const MAX_UNIT_CHARS: usize = 5;
/// Words in a category, series, stage or axis label.
const MAX_LABEL_WORDS: usize = 4;

/// The box the theme draws a picture in (viewBox units = CSS pixels).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PictureBox {
    pub width: f64,
    pub height: f64,
}

/// `chart` layout: full width under the headline.
pub const CHART_BOX: PictureBox = PictureBox {
    width: 1680.0,
    height: 640.0,
};
/// `image-left` layout: the picture column. A drawn chart is 820 x 600; a
/// model's svg may be up to 840 tall.
pub const IMAGE_LEFT_BOX: PictureBox = PictureBox {
    width: 820.0,
    height: 600.0,
};
pub const IMAGE_LEFT_SVG_BOX: PictureBox = PictureBox {
    width: 820.0,
    height: 840.0,
};

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Series {
    #[serde(default)]
    pub name: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stage {
    pub label: String,
    pub value: f64,
}

/// Bar and line charts: categories along the bottom, one value per category
/// in each series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct XySpec {
    pub categories: Vec<String>,
    pub series: Vec<Series>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunnelSpec {
    pub stages: Vec<Stage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_suffix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChartSpec {
    Bar(XySpec),
    Line(XySpec),
    Funnel(FunnelSpec),
}

/// Parse a model's `chart` value. Errors are whole sentences.
pub fn parse_spec(value: &Value) -> Result<ChartSpec, Vec<String>> {
    let Some(obj) = value.as_object() else {
        return Err(vec![
            "chart must be an object such as {\"type\": \"bar\", \"categories\": [...], \"series\": [...]}.".to_string(),
        ]);
    };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if !matches!(kind, "bar" | "line" | "funnel") {
        let shown = if kind.is_empty() {
            "chart.type is missing".to_string()
        } else {
            format!("chart.type \"{kind}\" is not supported")
        };
        return Err(vec![format!("{shown}; use bar, line or funnel.")]);
    }
    let mut cleaned = obj.clone();
    // Optional fields sent as null mean "not set".
    cleaned.retain(|_, v| !v.is_null());
    serde_json::from_value(Value::Object(cleaned))
        .map_err(|e| vec![format!("chart is not a valid {kind} chart: {e}.")])
}

// ---------------------------------------------------------------------------
// Text and numbers
// ---------------------------------------------------------------------------

fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Estimated rendered width of `text` at `size`.
pub fn est_width(text: &str, size: f64) -> f64 {
    text.chars().count() as f64 * CHAR_EM * size
}

/// Greedy word wrap into at most `max_lines` lines no wider than `max_width`.
/// `None` when a word alone is too wide or more lines are needed.
fn wrap(text: &str, size: f64, max_width: f64, max_lines: usize) -> Option<Vec<String>> {
    let mut lines: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        if est_width(word, size) > max_width {
            return None;
        }
        match lines.last_mut() {
            Some(line) if est_width(&format!("{line} {word}"), size) <= max_width => {
                line.push(' ');
                line.push_str(word);
            }
            _ => lines.push(word.to_string()),
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    (lines.len() <= max_lines).then_some(lines)
}

/// A coordinate: at most two decimals, no trailing zeros.
fn n(x: f64) -> String {
    let s = format!("{x:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() {
        "0".to_string()
    } else {
        s.to_string()
    }
}

/// Decimals needed to show `x` exactly (at most 6).
fn decimals_for(x: f64) -> usize {
    for d in 0..=6 {
        let m = x.abs() * 10f64.powi(d as i32);
        if (m - m.round()).abs() < 1e-6 * m.max(1.0) {
            return d;
        }
    }
    6
}

fn group_thousands(digits: &str) -> String {
    let bytes = digits.as_bytes();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

fn format_number(v: f64, decimals: usize) -> String {
    let s = format!("{:.*}", decimals, v.abs());
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i.to_string(), Some(f.to_string())),
        None => (s.clone(), None),
    };
    let mut out = String::new();
    let rounds_to_zero = s.chars().all(|c| c == '0' || c == '.');
    if v < 0.0 && !rounds_to_zero {
        out.push('-');
    }
    out.push_str(&group_thousands(&int));
    if let Some(frac) = frac {
        out.push('.');
        out.push_str(&frac);
    }
    out
}

struct Units<'a> {
    prefix: &'a str,
    suffix: &'a str,
}

impl Units<'_> {
    fn label(&self, v: f64, decimals: usize) -> String {
        let num = format_number(v, decimals);
        match num.strip_prefix('-') {
            Some(abs) => format!("-{}{abs}{}", self.prefix, self.suffix),
            None => format!("{}{num}{}", self.prefix, self.suffix),
        }
    }
    /// A data value: as many decimals as it has, at most two.
    fn value(&self, v: f64) -> String {
        self.label(v, decimals_for(v).min(2))
    }
}

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

/// A value axis with "nice" ticks: `min`, `min + step`, ... `max`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Axis {
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

impl Axis {
    pub fn ticks(&self) -> Vec<f64> {
        let count = ((self.max - self.min) / self.step).round() as usize;
        (0..=count)
            .map(|i| {
                let t = self.min + i as f64 * self.step;
                // Snap float noise (0.30000000000000004) to the step's decimals.
                let d = decimals_for(self.step) as i32;
                (t * 10f64.powi(d)).round() / 10f64.powi(d)
            })
            .collect()
    }
}

fn nice_step(range: f64, target: f64) -> f64 {
    let raw = (range / target).max(f64::MIN_POSITIVE);
    let mag = 10f64.powf(raw.log10().floor());
    let norm = raw / mag;
    let nice = if norm <= 1.0 {
        1.0
    } else if norm <= 2.0 {
        2.0
    } else if norm <= 2.5 {
        2.5
    } else if norm <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * mag
}

/// An axis from 0 up to at least `max` (bars and funnels start at 0).
pub fn zero_axis(max: f64) -> Axis {
    if max <= 0.0 {
        return Axis {
            min: 0.0,
            max: 1.0,
            step: 0.2,
        };
    }
    let step = nice_step(max, 5.0);
    let top = (max / step - 1e-9).ceil().max(1.0) * step;
    Axis {
        min: 0.0,
        max: top,
        step,
    }
}

/// An axis covering `min..=max` (lines need not start at 0).
pub fn range_axis(min: f64, max: f64) -> Axis {
    let (min, max) = if (max - min).abs() < f64::EPSILON {
        let pad = if max == 0.0 { 1.0 } else { max.abs() / 2.0 };
        (min - pad, max + pad)
    } else {
        (min, max)
    };
    let step = nice_step(max - min, 5.0);
    let lo = (min / step + 1e-9).floor() * step;
    let hi = (max / step - 1e-9).ceil() * step;
    Axis {
        min: lo,
        max: if hi > lo { hi } else { lo + step },
        step,
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn check_label(errors: &mut Vec<String>, path: &str, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        errors.push(format!("{path} is empty; give it a short label."));
    } else if word_count(text) > MAX_LABEL_WORDS {
        errors.push(format!(
            "{path} \"{text}\" is {} words; at most {MAX_LABEL_WORDS} — shorten it.",
            word_count(text)
        ));
    }
}

fn check_units(errors: &mut Vec<String>, prefix: &Option<String>, suffix: &Option<String>) {
    for (name, unit) in [("unit_prefix", prefix), ("unit_suffix", suffix)] {
        if let Some(unit) = unit {
            if unit.chars().count() > MAX_UNIT_CHARS {
                errors.push(format!(
                    "chart.{name} \"{unit}\" is {} characters; at most {MAX_UNIT_CHARS} — put words in y_label.",
                    unit.chars().count()
                ));
            }
        }
    }
}

fn check_xy(errors: &mut Vec<String>, spec: &XySpec, bar: bool) {
    let kind = if bar { "bar" } else { "line" };
    let (max_cats, max_series, min_cats) = if bar { (12, 3, 1) } else { (24, 4, 2) };
    let cats = spec.categories.len();
    if cats < min_cats {
        errors.push(format!(
            "chart.categories has {cats} items; a {kind} chart needs at least {min_cats}."
        ));
    } else if cats > max_cats {
        errors.push(format!(
            "chart.categories has {cats} items; at most {max_cats} for a {kind} chart — group the smallest{}.",
            if bar { " or use a line chart" } else { "" }
        ));
    }
    for (i, c) in spec.categories.iter().enumerate() {
        check_label(errors, &format!("chart.categories[{i}]"), c);
    }
    let series = spec.series.len();
    if series == 0 {
        errors.push("chart.series is empty; give at least one series with values.".to_string());
    } else if series > max_series {
        errors.push(format!(
            "chart.series has {series} items; at most {max_series} for a {kind} chart — drop or combine series."
        ));
    }
    for (s, ser) in spec.series.iter().enumerate() {
        // A lone series needs no name (there is no legend), but a long one
        // is still refused.
        if series > 1 || word_count(&ser.name) > MAX_LABEL_WORDS {
            check_label(errors, &format!("chart.series[{s}].name"), &ser.name);
        }
        if ser.values.len() != cats {
            errors.push(format!(
                "chart.series[{s}].values has {} numbers; categories has {cats} — give one value per category.",
                ser.values.len()
            ));
        }
        for (i, v) in ser.values.iter().enumerate() {
            if !v.is_finite() {
                errors.push(format!(
                    "chart.series[{s}].values[{i}] is not a finite number."
                ));
            } else if bar && *v < 0.0 {
                errors.push(format!(
                    "chart.series[{s}].values[{i}] is negative; bars start at 0 — use a line chart for values below zero."
                ));
            }
        }
    }
    if let Some(highlight) = &spec.highlight {
        if !bar {
            errors.push("chart.highlight is only for bar charts — leave it out.".to_string());
        } else {
            for (i, h) in highlight.iter().enumerate() {
                if *h < 0 || *h as usize >= cats {
                    errors.push(format!(
                        "chart.highlight[{i}] is {h}; categories has {cats} — use 0-based indexes from 0 to {}.",
                        cats.saturating_sub(1)
                    ));
                }
            }
        }
    }
    if let Some(label) = &spec.y_label {
        if word_count(label) > MAX_LABEL_WORDS {
            check_label(errors, "chart.y_label", label);
        }
    }
    check_units(errors, &spec.unit_prefix, &spec.unit_suffix);
}

fn check_funnel(errors: &mut Vec<String>, spec: &FunnelSpec) {
    let count = spec.stages.len();
    if count < 2 {
        errors.push(format!(
            "chart.stages has {count} items; a funnel needs at least 2."
        ));
    } else if count > 7 {
        errors.push(format!(
            "chart.stages has {count} items; at most 7 — merge stages."
        ));
    }
    for (i, stage) in spec.stages.iter().enumerate() {
        check_label(errors, &format!("chart.stages[{i}].label"), &stage.label);
        if !stage.value.is_finite() {
            errors.push(format!("chart.stages[{i}].value is not a finite number."));
        } else if stage.value < 0.0 {
            errors.push(format!(
                "chart.stages[{i}].value is negative; funnel stages are counts of 0 or more."
            ));
        }
    }
    if count >= 2 && spec.stages.iter().all(|s| s.value <= 0.0) {
        errors
            .push("chart.stages are all 0; a funnel needs at least one value above 0.".to_string());
    }
    check_units(errors, &spec.unit_prefix, &spec.unit_suffix);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GAP: f64 = 8.0;

fn text(x: f64, y: f64, size: f64, anchor: &str, color: &str, extra: &str, body: &str) -> String {
    format!(
        "<text x=\"{}\" y=\"{}\" font-size=\"{}\" text-anchor=\"{anchor}\" style=\"fill:var(--{color}){extra}\">{body}</text>",
        n(x),
        n(y),
        n(size)
    )
}

/// Lines centered on `x`, the first baseline at `y`.
fn multiline(x: f64, y: f64, size: f64, anchor: &str, color: &str, lines: &[String]) -> String {
    let mut body = String::new();
    for (i, line) in lines.iter().enumerate() {
        let dy = if i == 0 { 0.0 } else { size * LINE_HEIGHT };
        body.push_str(&format!(
            "<tspan x=\"{}\" dy=\"{}\">{}</tspan>",
            n(x),
            n(dy),
            escape_text(line)
        ));
    }
    text(x, y, size, anchor, color, "", &body)
}

/// Fill style of a series swatch or bar. `dim` fades a bar that is not
/// highlighted in a multi-series chart.
fn bar_style(series_index: usize, series_count: usize, highlighted: Option<bool>) -> String {
    if series_count == 1 {
        match highlighted {
            Some(false) => "fill:var(--surface);stroke:var(--ink-2);stroke-width:2".to_string(),
            _ => "fill:var(--accent)".to_string(),
        }
    } else {
        let s = match series_index {
            0 => "fill:var(--accent)",
            1 => "fill:var(--ink-2)",
            _ => "fill:var(--surface);stroke:var(--ink-2);stroke-width:2",
        };
        match highlighted {
            Some(false) => format!("{s};fill-opacity:0.35;stroke-opacity:0.35"),
            _ => s.to_string(),
        }
    }
}

fn line_style(series_index: usize) -> (&'static str, &'static str) {
    match series_index {
        0 => ("accent", ""),
        1 => ("ink", ""),
        2 => ("ink-2", ""),
        _ => ("ink-2", ";stroke-dasharray:14 10"),
    }
}

/// Header row: y label on the left, legend on the right (second row when
/// both do not fit). Returns the markup and the height used.
fn header(
    bx: PictureBox,
    y_label: Option<&str>,
    legend: &[(String, String)],
    errors: &mut Vec<String>,
) -> (String, f64) {
    let row = MIN_FONT * LINE_HEIGHT + 12.0;
    let swatch = 22.0;
    let item_width = |name: &str| swatch + 10.0 + est_width(name, MIN_FONT) + 28.0;
    let legend_width: f64 = legend.iter().map(|(name, _)| item_width(name)).sum::<f64>() - 28.0;
    let label_width = y_label.map_or(0.0, |l| est_width(l, MIN_FONT));
    if !legend.is_empty() && legend_width > bx.width {
        errors.push(format!(
            "chart series names are too long for a {}-wide legend — shorten them.",
            n(bx.width)
        ));
        return (String::new(), 0.0);
    }
    let mut out = String::new();
    let mut height = 0.0;
    if let Some(label) = y_label {
        out.push_str(&text(
            0.0,
            MIN_FONT,
            MIN_FONT,
            "start",
            "ink-2",
            "",
            &escape_text(label),
        ));
        height = row;
    }
    if !legend.is_empty() {
        let same_row = y_label.is_none() || label_width + 48.0 + legend_width <= bx.width;
        let top = if same_row { 0.0 } else { row };
        let mut x = bx.width - legend_width;
        for (name, style) in legend {
            out.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{swatch}\" height=\"{swatch}\" style=\"{style}\"/>",
                n(x),
                n(top + 6.0)
            ));
            out.push_str(&text(
                x + swatch + 10.0,
                top + MIN_FONT,
                MIN_FONT,
                "start",
                "ink",
                "",
                &escape_text(name),
            ));
            x += item_width(name);
        }
        height = top + row;
    }
    (out, height)
}

/// The value axis's tick labels, with the step's decimals and the units.
fn tick_labels(axis: &Axis, units: &Units) -> Vec<String> {
    let d = decimals_for(axis.step);
    axis.ticks().iter().map(|t| units.label(*t, d)).collect()
}

fn render_xy(spec: &XySpec, bar: bool, bx: PictureBox) -> Result<String, Vec<String>> {
    let mut errors = Vec::new();
    check_xy(&mut errors, spec, bar);
    if !errors.is_empty() {
        return Err(errors);
    }
    let units = Units {
        prefix: spec.unit_prefix.as_deref().unwrap_or(""),
        suffix: spec.unit_suffix.as_deref().unwrap_or(""),
    };
    let all: Vec<f64> = spec
        .series
        .iter()
        .flat_map(|s| s.values.iter().copied())
        .collect();
    let max = all.iter().copied().fold(f64::MIN, f64::max);
    let min = all.iter().copied().fold(f64::MAX, f64::min);
    let axis = if bar {
        zero_axis(max)
    } else {
        range_axis(min, max)
    };
    let ticks = axis.ticks();
    let tick_text = tick_labels(&axis, &units);
    let left = tick_text
        .iter()
        .map(|t| est_width(t, MIN_FONT))
        .fold(0.0, f64::max)
        + 18.0;
    let right = bx.width - GAP;
    let plot_width = right - left;
    let cats = spec.categories.len();
    let band = plot_width / cats as f64;
    let series_count = spec.series.len();
    let highlight: Vec<usize> = spec
        .highlight
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|h| *h as usize)
        .collect();
    let highlighted = |i: usize| (!highlight.is_empty()).then(|| highlight.contains(&i));

    // Legend for more than one series.
    let legend: Vec<(String, String)> = if series_count > 1 {
        spec.series
            .iter()
            .enumerate()
            .map(|(s, ser)| {
                let style = if bar {
                    bar_style(s, series_count, None)
                } else {
                    let (color, dash) = line_style(s);
                    format!("fill:var(--{color}){dash}")
                };
                (ser.name.trim().to_string(), style)
            })
            .collect()
    } else {
        Vec::new()
    };
    let y_label = spec
        .y_label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    let (head, head_height) = header(bx, y_label, &legend, &mut errors);

    // Category labels: every one for bars, every k-th for lines.
    let label_room = |k: usize| band * k as f64 - 12.0;
    let mut every = 1;
    let wrapped: Vec<Option<Vec<String>>> = loop {
        let attempt: Vec<Option<Vec<String>>> = spec
            .categories
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if i % every == 0 {
                    wrap(c.trim(), LABEL_FONT, label_room(every), 2)
                } else {
                    Some(Vec::new())
                }
            })
            .collect();
        let fits = attempt.iter().all(Option::is_some);
        if fits || bar || every >= cats {
            break attempt;
        }
        every += 1;
    };
    for (i, w) in wrapped.iter().enumerate() {
        if w.is_none() {
            errors.push(format!(
                "chart.categories[{i}] \"{}\" is too wide for its place in a {}-wide chart — shorten the labels or use fewer categories{}.",
                spec.categories[i].trim(),
                n(bx.width),
                if bx == IMAGE_LEFT_BOX { ", or use layout chart" } else { "" }
            ));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let label_lines = wrapped
        .iter()
        .map(|w| w.as_ref().map_or(0, Vec::len))
        .max()
        .unwrap_or(1)
        .max(1);
    let bottom_room = label_lines as f64 * LABEL_FONT * LINE_HEIGHT + 14.0;
    let value_room = if bar { MIN_FONT + 16.0 } else { 16.0 };
    let top = head_height + value_room;
    let base = bx.height - bottom_room;
    let plot_height = base - top;
    let y_of = |v: f64| base - (v - axis.min) / (axis.max - axis.min) * plot_height;

    let mut out = String::new();
    out.push_str(&head);
    // Gridlines and tick labels.
    for (t, label) in ticks.iter().zip(&tick_text) {
        let y = y_of(*t);
        let opacity = if bar && *t == 0.0 { "0.6" } else { "0.25" };
        out.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" style=\"stroke:var(--ink-2);stroke-width:2;stroke-opacity:{opacity}\"/>",
            n(left),
            n(y),
            n(right),
            n(y)
        ));
        out.push_str(&text(
            left - 14.0,
            y + 9.0,
            MIN_FONT,
            "end",
            "ink-2",
            "",
            &escape_text(label),
        ));
    }

    if bar {
        let group = band * 0.7;
        let gap = if series_count > 1 { GAP } else { 0.0 };
        let bar_width = (group - gap * (series_count as f64 - 1.0)) / series_count as f64;
        let slot = if series_count > 1 {
            bar_width + gap
        } else {
            band - GAP
        };
        let labels: Vec<Vec<String>> = spec
            .series
            .iter()
            .map(|s| s.values.iter().map(|v| units.value(*v)).collect())
            .collect();
        let show_values = labels
            .iter()
            .flatten()
            .all(|l| est_width(l, MIN_FONT) <= slot);
        for (s, ser) in spec.series.iter().enumerate() {
            for (i, (v, label)) in ser.values.iter().copied().zip(&labels[s]).enumerate() {
                let x0 = left + band * i as f64 + (band - group) / 2.0;
                let x = x0 + (bar_width + gap) * s as f64;
                let h = v / axis.max * plot_height;
                out.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" style=\"{}\"/>",
                    n(x),
                    n(base - h),
                    n(bar_width),
                    n(h),
                    bar_style(s, series_count, highlighted(i))
                ));
                if show_values {
                    out.push_str(&text(
                        x + bar_width / 2.0,
                        base - h - 12.0,
                        MIN_FONT,
                        "middle",
                        "ink",
                        ";font-weight:600",
                        &escape_text(label),
                    ));
                }
            }
        }
    } else {
        for (s, ser) in spec.series.iter().enumerate() {
            let (color, dash) = line_style(s);
            let points: Vec<String> = ser
                .values
                .iter()
                .enumerate()
                .map(|(i, v)| format!("{},{}", n(left + band * (i as f64 + 0.5)), n(y_of(*v))))
                .collect();
            out.push_str(&format!(
                "<polyline points=\"{}\" style=\"fill:none;stroke:var(--{color});stroke-width:5;stroke-linejoin:round;stroke-linecap:round{dash}\"/>",
                points.join(" ")
            ));
            for (i, v) in ser.values.iter().enumerate() {
                out.push_str(&format!(
                    "<circle cx=\"{}\" cy=\"{}\" r=\"7\" style=\"fill:var(--{color})\"/>",
                    n(left + band * (i as f64 + 0.5)),
                    n(y_of(*v))
                ));
            }
        }
    }

    // Category labels under the plot.
    for (i, lines) in wrapped.iter().enumerate() {
        let Some(lines) = lines else { continue };
        if lines.is_empty() {
            continue;
        }
        let cx = left + band * (i as f64 + 0.5);
        out.push_str(&multiline(
            cx,
            base + 12.0 + LABEL_FONT,
            LABEL_FONT,
            "middle",
            "ink-2",
            lines,
        ));
    }
    Ok(out)
}

fn render_funnel(spec: &FunnelSpec, bx: PictureBox) -> Result<String, Vec<String>> {
    let mut errors = Vec::new();
    check_funnel(&mut errors, spec);
    if !errors.is_empty() {
        return Err(errors);
    }
    let units = Units {
        prefix: spec.unit_prefix.as_deref().unwrap_or(""),
        suffix: spec.unit_suffix.as_deref().unwrap_or(""),
    };
    let values: Vec<String> = spec.stages.iter().map(|s| units.value(s.value)).collect();
    let value_width = values
        .iter()
        .map(|v| est_width(v, LABEL_FONT))
        .fold(0.0, f64::max);
    let label_max = bx.width * 0.34;
    let mut labels = Vec::new();
    for (i, stage) in spec.stages.iter().enumerate() {
        match wrap(stage.label.trim(), LABEL_FONT, label_max, 2) {
            Some(lines) => labels.push(lines),
            None => errors.push(format!(
                "chart.stages[{i}].label \"{}\" is too wide for a {}-wide funnel — shorten it.",
                stage.label.trim(),
                n(bx.width)
            )),
        }
    }
    if value_width > bx.width * 0.25 {
        errors.push(format!(
            "chart funnel values are too wide for a {}-wide funnel — use unit_suffix such as \"K\" or \"M\" for big numbers.",
            n(bx.width)
        ));
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let label_width = labels
        .iter()
        .flatten()
        .map(|l| est_width(l, LABEL_FONT))
        .fold(0.0, f64::max);
    let gutter = 24.0;
    let area_left = label_width + gutter;
    let area_right = bx.width - value_width - gutter;
    let area = area_right - area_left;
    let max = spec.stages.iter().map(|s| s.value).fold(0.0, f64::max);
    let row = bx.height / spec.stages.len() as f64;
    let bar_height = (row * 0.72).min(110.0);
    let line = LABEL_FONT * LINE_HEIGHT;
    let mut out = String::new();
    for (i, stage) in spec.stages.iter().enumerate() {
        let cy = row * (i as f64 + 0.5);
        let width = stage.value / max * area;
        let x = area_left + (area - width) / 2.0;
        out.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"6\" style=\"fill:var(--accent)\"/>",
            n(x),
            n(cy - bar_height / 2.0),
            n(width),
            n(bar_height)
        ));
        let lines = &labels[i];
        let first = cy - (lines.len() as f64 - 1.0) * line / 2.0 + LABEL_FONT * 0.35;
        out.push_str(&multiline(0.0, first, LABEL_FONT, "start", "ink", lines));
        out.push_str(&text(
            bx.width,
            cy + LABEL_FONT * 0.35,
            LABEL_FONT,
            "end",
            "ink",
            ";font-weight:600",
            &escape_text(&values[i]),
        ));
    }
    Ok(out)
}

/// Render a chart into `bx`. The root carries the spec as `data-chart`.
pub fn render(spec: &ChartSpec, bx: PictureBox) -> Result<String, Vec<String>> {
    let body = match spec {
        ChartSpec::Bar(xy) => render_xy(xy, true, bx)?,
        ChartSpec::Line(xy) => render_xy(xy, false, bx)?,
        ChartSpec::Funnel(f) => render_funnel(f, bx)?,
    };
    let json = serde_json::to_string(spec).map_err(|e| vec![format!("chart: {e}")])?;
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" role=\"img\" data-chart=\"{}\"><g style=\"font-family:var(--font-body)\">{body}</g></svg>",
        n(bx.width),
        n(bx.height),
        escape_text(&json)
    ))
}

/// The spec stored on a rendered chart's root, if `svg` is one.
pub fn stored_spec(svg: &str) -> Option<ChartSpec> {
    let tok = slide_html::scan(svg).into_iter().next()?;
    let TokKind::Open { name, .. } = &tok.kind else {
        return None;
    };
    if name != "svg" {
        return None;
    }
    let attrs = slide_html::parse_attrs(&svg[tok.range.clone()]);
    let raw = attrs
        .iter()
        .find(|a| a.name == "data-chart")?
        .value
        .as_deref()?;
    serde_json::from_str(&slide_html::unescape_attr(raw)).ok()
}

// ---------------------------------------------------------------------------
// A model's own svg
// ---------------------------------------------------------------------------

/// Root attributes the app removes: the theme sizes the picture, and
/// `data-chart` belongs to drawn charts only.
const STRIPPED_ROOT_ATTRS: [&str; 4] = ["width", "height", "style", "data-chart"];
/// Text smaller than this on the slide is rejected.
const MIN_RENDERED_TEXT: f64 = 20.0;

fn parse_viewbox(value: &str) -> Option<(f64, f64)> {
    let parts: Vec<f64> = value
        .split(|c: char| c.is_ascii_whitespace() || c == ',')
        .filter(|p| !p.is_empty())
        .map(str::parse::<f64>)
        .collect::<Result<_, _>>()
        .ok()?;
    match parts.as_slice() {
        [_, _, w, h] if *w > 0.0 && *h > 0.0 && w.is_finite() && h.is_finite() => Some((*w, *h)),
        _ => None,
    }
}

/// A font-size value relative to the inherited size: unitless or px numbers,
/// em, rem (against the default 16) and %. Other units are ignored.
fn font_size(value: &str, inherited: f64) -> Option<f64> {
    let v = value.trim().to_ascii_lowercase();
    let num = |s: &str| {
        s.trim()
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite() && *x > 0.0)
    };
    if let Some(s) = v.strip_suffix("px") {
        num(s)
    } else if let Some(s) = v.strip_suffix("rem") {
        num(s).map(|x| x * 16.0)
    } else if let Some(s) = v.strip_suffix("em") {
        num(s).map(|x| x * inherited)
    } else if let Some(s) = v.strip_suffix('%') {
        num(s).map(|x| x / 100.0 * inherited)
    } else {
        num(&v)
    }
}

fn style_font_size(style: &str) -> Option<&str> {
    style.split(';').find_map(|decl| {
        let (prop, value) = decl.split_once(':')?;
        (prop.trim().eq_ignore_ascii_case("font-size")).then_some(value)
    })
}

/// Check a model's svg against the rules and return it with the root's
/// width, height, style and data-chart removed. `bx` is the box it is drawn
/// in. Errors are whole sentences.
pub fn check_svg(svg: &str, bx: PictureBox) -> Result<String, Vec<String>> {
    let svg = svg.trim();
    let mut errors = Vec::new();
    if svg.to_ascii_lowercase().contains("<script") {
        errors
            .push("the svg contains a <script>; slides can't run scripts — remove it.".to_string());
    }
    let toks = slide_html::scan(svg);
    let root_ok = toks.first().is_some_and(|t| {
        t.range.start == 0 && matches!(&t.kind, TokKind::Open { name, .. } if name == "svg")
    });
    let mut root_end = None;
    if root_ok {
        let mut depth = 0usize;
        for tok in &toks {
            match &tok.kind {
                TokKind::Open { name, self_closing } if name == "svg" && !self_closing => {
                    depth += 1;
                }
                TokKind::Close { name } if name == "svg" => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        root_end = Some(tok.range.end);
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    if root_end != Some(svg.len()) {
        errors.push(
            "svg must be exactly one <svg>…</svg> element with nothing before or after it."
                .to_string(),
        );
        return Err(errors);
    }

    // Attributes: no event handlers, no external links.
    let mut bad_events: Vec<String> = Vec::new();
    let mut bad_links: Vec<String> = Vec::new();
    for tok in &toks {
        if let TokKind::Open { .. } = &tok.kind {
            for attr in slide_html::parse_attrs(&svg[tok.range.clone()]) {
                if attr.name.starts_with("on") && !bad_events.contains(&attr.name) {
                    bad_events.push(attr.name.clone());
                }
                if attr.name == "href" || attr.name == "xlink:href" {
                    let value = attr.value.as_deref().unwrap_or("").trim().to_string();
                    let local =
                        value.starts_with('#') || value.to_ascii_lowercase().starts_with("data:");
                    if !local && !bad_links.contains(&value) {
                        bad_links.push(value);
                    }
                }
            }
        }
    }
    if !bad_events.is_empty() {
        errors.push(format!(
            "the svg has event attributes ({}); slides can't run scripts — remove them.",
            bad_events.join(", ")
        ));
    }
    if !bad_links.is_empty() {
        errors.push(format!(
            "the svg links to {}; only #id and data: links work — embed the picture or drop it.",
            bad_links
                .iter()
                .map(|l| format!("\"{l}\""))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    // Root: viewBox required; width, height, style, data-chart removed.
    let root = toks[0].range.clone();
    let root_tag = &svg[root.clone()];
    let root_attrs = slide_html::parse_attrs(root_tag);
    let viewbox = root_attrs
        .iter()
        .find(|a| a.name == "viewbox")
        .and_then(|a| a.value.as_deref())
        .and_then(parse_viewbox);
    let Some((vb_w, vb_h)) = viewbox else {
        errors.push(format!(
            "the svg has no usable viewBox; add one such as viewBox=\"0 0 {} {}\" (the box it is drawn in).",
            n(bx.width),
            n(bx.height)
        ));
        return Err(errors);
    };
    let mut new_tag = root_tag.to_string();
    let mut strip: Vec<_> = root_attrs
        .iter()
        .filter(|a| STRIPPED_ROOT_ATTRS.contains(&a.name.as_str()))
        .map(|a| a.range.clone())
        .collect();
    strip.sort_by_key(|r| std::cmp::Reverse(r.start));
    for range in strip {
        let mut start = range.start;
        while start > 0 && new_tag.as_bytes()[start - 1].is_ascii_whitespace() {
            start -= 1;
        }
        new_tag.replace_range(start..range.end, "");
    }

    // Text size on the slide: the inherited font-size times the drawing scale.
    let scale_w = bx.width / vb_w;
    let scale_h = bx.height / vb_h;
    let scale = scale_w.min(scale_h);
    let mut stack: Vec<(String, f64)> = Vec::new();
    let mut smallest: Option<f64> = None;
    for (i, tok) in toks.iter().enumerate() {
        match &tok.kind {
            TokKind::Open { name, self_closing } => {
                let inherited = stack.last().map_or(16.0, |(_, fs)| *fs);
                let tag_text = if i == 0 {
                    new_tag.as_str()
                } else {
                    &svg[tok.range.clone()]
                };
                let attrs = slide_html::parse_attrs(tag_text);
                let from_style = attrs
                    .iter()
                    .find(|a| a.name == "style")
                    .and_then(|a| a.value.as_deref())
                    .and_then(style_font_size)
                    .and_then(|v| font_size(v, inherited));
                let from_attr = attrs
                    .iter()
                    .find(|a| a.name == "font-size")
                    .and_then(|a| a.value.as_deref())
                    .and_then(|v| font_size(v, inherited));
                let size = from_style.or(from_attr).unwrap_or(inherited);
                if name == "text" || name == "tspan" {
                    smallest = Some(smallest.map_or(size, |s: f64| s.min(size)));
                }
                if !self_closing && !slide_html::is_void(name) {
                    stack.push((name.clone(), size));
                }
            }
            TokKind::Close { name } => {
                if let Some(pos) = stack.iter().rposition(|(n, _)| n == name) {
                    stack.truncate(pos);
                }
            }
            TokKind::Comment => {}
        }
    }
    if let Some(size) = smallest {
        let rendered = size * scale;
        if rendered < MIN_RENDERED_TEXT {
            let (drawn, axis) = if scale_w <= scale_h {
                (
                    format!("viewBox {} wide drawn {} wide", n(vb_w), n(bx.width)),
                    "wide",
                )
            } else {
                (
                    format!("viewBox {} tall drawn {} tall", n(vb_h), n(bx.height)),
                    "tall",
                )
            };
            let advice = if axis == "wide" {
                format!(
                    "use a viewBox about {} wide and font-size ≥ 24",
                    n(bx.width)
                )
            } else {
                format!(
                    "use a viewBox about {} wide and at most {} tall, and font-size ≥ 24",
                    n(bx.width),
                    n(bx.height)
                )
            };
            errors.push(format!(
                "the svg's smallest label renders at {}px (font-size {} × scale {}: {drawn}); {advice}.",
                rendered.round(),
                n(size),
                n(scale)
            ));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(format!("{new_tag}{}", &svg[root.end..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(v: Value) -> ChartSpec {
        parse_spec(&v).unwrap()
    }

    /// Every element's attributes, in order, as (tag, attrs, inner text).
    fn elements(svg: &str, tag: &str) -> Vec<std::collections::HashMap<String, String>> {
        let toks = slide_html::scan(svg);
        let mut out = Vec::new();
        for (i, tok) in toks.iter().enumerate() {
            if let TokKind::Open { name, .. } = &tok.kind {
                if name == tag {
                    let mut map: std::collections::HashMap<String, String> =
                        slide_html::parse_attrs(&svg[tok.range.clone()])
                            .into_iter()
                            .map(|a| (a.name, a.value.unwrap_or_default()))
                            .collect();
                    // The text up to the next tag (or the first tspan's text).
                    let after = tok.range.end;
                    let next = toks.get(i + 1).map_or(svg.len(), |t| t.range.start);
                    let mut body = svg[after..next].to_string();
                    if body.is_empty() {
                        if let (Some(t1), Some(t2)) = (toks.get(i + 1), toks.get(i + 2)) {
                            body = svg[t1.range.end..t2.range.start].to_string();
                        }
                    }
                    map.insert("#text".to_string(), body);
                    out.push(map);
                }
            }
        }
        out
    }

    fn num(map: &std::collections::HashMap<String, String>, key: &str) -> f64 {
        map[key].parse().unwrap()
    }

    #[test]
    fn nice_ticks_from_the_data() {
        assert_eq!(
            zero_axis(87.0),
            Axis {
                min: 0.0,
                max: 100.0,
                step: 20.0
            }
        );
        assert_eq!(
            zero_axis(4.2),
            Axis {
                min: 0.0,
                max: 5.0,
                step: 1.0
            }
        );
        assert_eq!(
            zero_axis(12.0).ticks(),
            vec![0.0, 2.5, 5.0, 7.5, 10.0, 12.5]
        );
        assert_eq!(zero_axis(1234.0).max, 1250.0);
        assert_eq!(zero_axis(0.3).ticks(), vec![0.0, 0.1, 0.2, 0.3]);
        let a = range_axis(-3.0, 17.0);
        assert_eq!((a.min, a.max, a.step), (-5.0, 20.0, 5.0));
        let flat = range_axis(5.0, 5.0);
        assert!(flat.min < 5.0 && flat.max > 5.0);
    }

    #[test]
    fn numbers_format_with_units_and_separators() {
        let u = Units {
            prefix: "$",
            suffix: "K",
        };
        assert_eq!(u.value(1234.5), "$1,234.5K");
        assert_eq!(u.value(-12.0), "-$12K");
        assert_eq!(u.value(1.23456), "$1.23K");
        assert_eq!(format_number(1_000_000.0, 0), "1,000,000");
        assert_eq!(n(12.0), "12");
        assert_eq!(n(12.346), "12.35");
        assert_eq!(n(-0.001), "0");
    }

    #[test]
    fn bar_heights_are_exactly_proportional_to_the_axis() {
        let s = spec(json!({
            "type": "bar",
            "categories": ["Q1", "Q2", "Q3", "Q4"],
            "series": [{ "name": "Revenue", "values": [12, 30, 45, 87] }],
            "unit_prefix": "$", "unit_suffix": "M", "highlight": [3], "y_label": "Revenue"
        }));
        let svg = render(&s, CHART_BOX).unwrap();
        let rects = elements(&svg, "rect");
        assert_eq!(rects.len(), 4);
        let base: f64 = num(&rects[0], "y") + num(&rects[0], "height");
        let per_unit = num(&rects[3], "height") / 87.0;
        for (r, v) in rects.iter().zip([12.0, 30.0, 45.0, 87.0]) {
            assert!((num(r, "height") - v * per_unit).abs() < 0.02, "{r:?}");
            assert!((num(r, "y") + num(r, "height") - base).abs() < 0.02);
        }
        // The axis top (100) sits exactly where a bar of 100 would end.
        let lines = elements(&svg, "line");
        let top_line = lines.iter().map(|l| num(l, "y1")).fold(f64::MAX, f64::min);
        assert!((base - 100.0 * per_unit - top_line).abs() < 0.02);
        // Highlight: accent for index 3, surface + ink-2 stroke for the rest.
        assert!(rects[3]["style"].contains("var(--accent)"));
        assert!(
            rects[0]["style"].contains("var(--surface)")
                && rects[0]["style"].contains("var(--ink-2)")
        );
        // Value labels on the bars, with units.
        assert!(svg.contains(">$87M<"), "{svg}");
        // Single series: no legend.
        assert!(!svg.contains("Revenue</text><rect"));
    }

    #[test]
    fn all_text_is_at_least_the_minimum_size() {
        let specs = [
            json!({ "type": "bar", "categories": ["A", "B"], "series": [{ "name": "x", "values": [1, 2] }, { "name": "y", "values": [3, 4] }] }),
            json!({ "type": "line", "categories": ["Jan", "Feb", "Mar"], "series": [{ "name": "x", "values": [-1, 2, 5] }] }),
            json!({ "type": "funnel", "stages": [{ "label": "Visits", "value": 1000 }, { "label": "Signups", "value": 120 }] }),
        ];
        for v in specs {
            for bx in [CHART_BOX, IMAGE_LEFT_BOX] {
                let svg = render(&spec(v.clone()), bx).unwrap();
                let texts = elements(&svg, "text");
                assert!(!texts.is_empty());
                for t in texts {
                    assert!(num(&t, "font-size") >= MIN_FONT, "{t:?}");
                }
                // A rendered chart passes the svg rules for its box.
                check_svg(&svg, bx).unwrap();
                assert!(svg.contains(&format!("viewBox=\"0 0 {} {}\"", n(bx.width), n(bx.height))));
            }
        }
    }

    #[test]
    fn legend_only_for_more_than_one_series() {
        let one = render(&spec(json!({ "type": "line", "categories": ["a", "b"], "series": [{ "name": "Solo", "values": [1, 2] }] })), CHART_BOX).unwrap();
        assert!(!one.contains(">Solo<"));
        let two = render(&spec(json!({ "type": "line", "categories": ["a", "b"], "series": [{ "name": "One", "values": [1, 2] }, { "name": "Two", "values": [2, 1] }] })), CHART_BOX).unwrap();
        assert!(two.contains(">One<") && two.contains(">Two<"));
    }

    #[test]
    fn funnel_labels_and_values_never_overlap_the_bars() {
        let s = spec(json!({ "type": "funnel", "stages": [
            { "label": "Site visitors this quarter", "value": 48000 },
            { "label": "Trial signups", "value": 3100 },
            { "label": "Activated", "value": 1400 },
            { "label": "Paid", "value": 380 }
        ] }));
        for bx in [CHART_BOX, IMAGE_LEFT_BOX] {
            let svg = render(&s, bx).unwrap();
            let rects = elements(&svg, "rect");
            let texts = elements(&svg, "text");
            let bar_left = rects.iter().map(|r| num(r, "x")).fold(f64::MAX, f64::min);
            let bar_right = rects
                .iter()
                .map(|r| num(r, "x") + num(r, "width"))
                .fold(f64::MIN, f64::max);
            // Widths proportional to the values, bars centred on one axis.
            let w0 = num(&rects[0], "width");
            assert!((num(&rects[2], "width") - w0 * 1400.0 / 48000.0).abs() < 0.05);
            let c0 = num(&rects[0], "x") + w0 / 2.0;
            let c3 = num(&rects[3], "x") + num(&rects[3], "width") / 2.0;
            assert!((c0 - c3).abs() < 0.02);
            for t in &texts {
                let size = num(t, "font-size");
                let body = t["#text"].clone();
                let width = est_width(&body, size);
                match t["text-anchor"].as_str() {
                    "start" => assert!(
                        num(t, "x") + width <= bar_left,
                        "{t:?} hits the bars at {bar_left}"
                    ),
                    "end" => {
                        assert!(
                            num(t, "x") - width >= bar_right,
                            "{t:?} hits the bars at {bar_right}"
                        );
                        assert!(num(t, "x") <= bx.width);
                    }
                    other => panic!("unexpected anchor {other}"),
                }
            }
        }
    }

    #[test]
    fn spec_round_trips_through_data_chart() {
        let s = spec(
            json!({ "type": "bar", "categories": ["A \"x\" & <y>", "B"], "series": [{ "name": "", "values": [1.5, 2] }], "highlight": [0] }),
        );
        let svg = render(&s, CHART_BOX).unwrap();
        assert_eq!(stored_spec(&svg), Some(s.clone()));
        // Rendering is deterministic, so a read-back spec redraws the same chart.
        assert_eq!(render(&stored_spec(&svg).unwrap(), CHART_BOX).unwrap(), svg);
        assert!(stored_spec("<svg viewBox=\"0 0 1 1\"></svg>").is_none());
    }

    #[test]
    fn spec_errors_are_sentences_naming_the_field() {
        let errs = |v: Value| -> Vec<String> {
            match parse_spec(&v) {
                Err(e) => e,
                Ok(s) => render(&s, CHART_BOX).unwrap_err(),
            }
        };
        assert!(errs(json!({ "type": "pie" }))[0].contains("chart.type \"pie\" is not supported"));
        let e = errs(
            json!({ "type": "bar", "categories": ["a", "b", "c"], "series": [{ "values": [1, 2] }] }),
        );
        assert_eq!(e, ["chart.series[0].values has 2 numbers; categories has 3 — give one value per category."]);
        let e = errs(
            json!({ "type": "bar", "categories": ["a", "b"], "series": [{ "values": [1, -2] }], "highlight": [5] }),
        );
        assert_eq!(e.len(), 2, "{e:?}");
        assert!(e[0].contains("negative") && e[1].contains("chart.highlight[0] is 5"));
        let e = errs(
            json!({ "type": "bar", "categories": ["one two three four five", "b"], "series": [{ "values": [1, 2] }] }),
        );
        assert!(
            e[0].starts_with(
                "chart.categories[0] \"one two three four five\" is 5 words; at most 4"
            ),
            "{e:?}"
        );
        let cats: Vec<String> = (0..13).map(|i| format!("c{i}")).collect();
        let vals: Vec<i32> = (0..13).collect();
        let e = errs(json!({ "type": "bar", "categories": cats, "series": [{ "values": vals }] }));
        assert!(e[0].contains("at most 12"), "{e:?}");
        let e = errs(
            json!({ "type": "line", "categories": ["a", "b"], "series": [{ "name": "", "values": [1, 2] }, { "name": "", "values": [1, 2] }] }),
        );
        assert!(
            e.iter()
                .any(|m| m.starts_with("chart.series[0].name is empty")),
            "{e:?}"
        );
        let e = errs(json!({ "type": "funnel", "stages": [{ "label": "only", "value": 1 }] }));
        assert!(e[0].contains("at least 2"));
    }

    #[test]
    fn crowded_labels_are_rejected_in_the_small_box() {
        let cats = [
            "Enterprise",
            "Mid-market",
            "Small business",
            "Startups",
            "Education",
            "Government",
            "Nonprofit",
            "Healthcare",
            "Retail",
            "Finance",
            "Media",
            "Travel",
        ];
        let vals: Vec<i32> = (1..=12).collect();
        let s = spec(json!({ "type": "bar", "categories": cats, "series": [{ "values": vals }] }));
        let e = render(&s, IMAGE_LEFT_BOX).unwrap_err();
        assert!(
            e[0].contains("too wide") && e[0].contains("layout chart"),
            "{e:?}"
        );
        // A line chart thins its labels instead.
        let months: Vec<String> = (1..=24).map(|m| format!("Month {m}")).collect();
        let vals: Vec<i32> = (1..=24).collect();
        let line = render(
            &spec(json!({ "type": "line", "categories": months, "series": [{ "values": vals }] })),
            CHART_BOX,
        )
        .unwrap();
        let shown = line.matches("dy=\"0\"").count();
        assert!((2..24).contains(&shown), "{shown}");
    }

    #[test]
    fn svg_rules() {
        let ok = check_svg(
            r##"<svg width="800" height="600" style="background:red" viewBox="0 0 820 600"><text font-size="28">Hi</text><use href="#a"/></svg>"##,
            IMAGE_LEFT_SVG_BOX,
        )
        .unwrap();
        assert_eq!(
            ok,
            r##"<svg viewBox="0 0 820 600"><text font-size="28">Hi</text><use href="#a"/></svg>"##
        );

        let e = check_svg(r#"<svg><rect/></svg>"#, CHART_BOX).unwrap_err();
        assert!(e[0].contains("viewBox"), "{e:?}");
        let e = check_svg(r#"<p>x</p><svg viewBox="0 0 1 1"></svg>"#, CHART_BOX).unwrap_err();
        assert!(e[0].contains("exactly one <svg>"), "{e:?}");
        let e = check_svg(
            r#"<svg viewBox="0 0 1 1"></svg><svg viewBox="0 0 1 1"></svg>"#,
            CHART_BOX,
        )
        .unwrap_err();
        assert!(e[0].contains("exactly one <svg>"), "{e:?}");
        let e = check_svg(
            r#"<svg viewBox="0 0 10 10" onload="x()"><script>1</script></svg>"#,
            CHART_BOX,
        )
        .unwrap_err();
        assert!(e.iter().any(|m| m.contains("<script>")), "{e:?}");
        assert!(
            e.iter().any(|m| m.contains("event attributes (onload)")),
            "{e:?}"
        );
        let e = check_svg(r#"<svg viewBox="0 0 10 10"><image href="https://x.test/a.png"/><image xlink:href="data:image/png;base64,AA"/></svg>"#, CHART_BOX).unwrap_err();
        assert_eq!(
            e,
            [
                r#"the svg links to "https://x.test/a.png"; only #id and data: links work — embed the picture or drop it."#
            ]
        );
    }

    #[test]
    fn svg_text_must_render_large_enough() {
        let e = check_svg(
            r#"<svg viewBox="0 0 1640 600"><text font-size="22">tiny</text></svg>"#,
            IMAGE_LEFT_SVG_BOX,
        )
        .unwrap_err();
        assert_eq!(
            e,
            ["the svg's smallest label renders at 11px (font-size 22 × scale 0.5: viewBox 1640 wide drawn 820 wide); use a viewBox about 820 wide and font-size ≥ 24."]
        );
        // Inherited from a group, in style, with units; default 16 when unset.
        let e = check_svg(r#"<svg viewBox="0 0 1680 640"><g font-size="40"><text style="font-size: 0.4em">x</text></g></svg>"#, CHART_BOX).unwrap_err();
        assert!(e[0].contains("renders at 16px"), "{e:?}");
        let e = check_svg(
            r#"<svg viewBox="0 0 1680 640"><text>x</text></svg>"#,
            CHART_BOX,
        )
        .unwrap_err();
        assert!(e[0].contains("font-size 16 × scale 1"), "{e:?}");
        assert!(check_svg(
            r#"<svg viewBox="0 0 1680 640"><g style="font-size:30px"><text>x</text></g></svg>"#,
            CHART_BOX
        )
        .is_ok());
        // A tall viewBox is drawn by its height.
        let e = check_svg(
            r#"<svg viewBox="0 0 1680 1280"><text font-size="30">x</text></svg>"#,
            CHART_BOX,
        )
        .unwrap_err();
        assert!(e[0].contains("viewBox 1280 tall drawn 640 tall"), "{e:?}");
    }
}
