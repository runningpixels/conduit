//! A slide saved to PowerPoint from its scene: what the deck frame measured
//! on the drawn slide (`src/slides/deckScene.ts`), placed exactly.
//!
//! The scene is a flat, paint-ordered list of boxes, pictures, charts and
//! text blocks in slide pixels. Each becomes a native shape: text stays text
//! (same font, size, weight, colour, spacing, line height, at the same box),
//! boxes are rectangles with the same fill, border and corner radius, charts
//! are native charts over the spec stored in the slide's own HTML. Only what
//! PowerPoint can't express (layered or radial gradients, drawings) becomes a
//! picture, of just that element.
//!
//! The scene comes from the renderer, so it is validated here: sizes and
//! counts are capped and every number must be finite. Nothing in it is a
//! path; a chart is named by its index among the slide's own charts.

use serde::Deserialize;

use crate::deck_pptx::{run_lang, xfrm, Canvas};
use crate::deck_pptx_parts::{
    emu, esc, face_for, hundredths, vertical_metrics, ChartData, SLIDE_H, SLIDE_W,
};
use crate::slide_charts;
use crate::slide_html::{self, TokKind};

/// Most slides a scene list may hold.
pub const MAX_SLIDES: usize = 500;
const MAX_ITEMS: usize = 2_000;
const MAX_TEXT_CHARS: usize = 100_000;
const MAX_SVG_BYTES: usize = 2_000_000;
const MAX_SLIDE_SVG_BYTES: usize = 8_000_000;
/// How far off the slide a box may sit (px) and still be kept.
const MARGIN: f64 = 2.0 * SLIDE_W;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideScene {
    pub id: String,
    pub bg: String,
    #[serde(default)]
    pub bg_svg: Option<String>,
    pub items: Vec<SceneItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SceneItem {
    Shape {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default)]
        radius: f64,
        fill: Option<Fill>,
        line: Option<Line>,
        #[serde(default)]
        shadow: Option<Shadow>,
    },
    Picture {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        svg: String,
    },
    Chart {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        index: usize,
    },
    Text {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default)]
        title: bool,
        paras: Vec<Para>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Fill {
    Solid { color: String },
    Linear { angle: f64, stops: Vec<Stop> },
}

#[derive(Debug, Clone, Deserialize)]
pub struct Stop {
    pub pos: f64,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Line {
    pub width: f64,
    pub color: String,
    #[serde(default)]
    pub dash: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Shadow {
    pub x: f64,
    pub y: f64,
    pub blur: f64,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Para {
    pub align: String,
    pub line_height: f64,
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Run {
    pub text: String,
    pub font: String,
    pub size: f64,
    pub weight: f64,
    #[serde(default)]
    pub italic: bool,
    pub color: String,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strike: bool,
    #[serde(default)]
    pub spacing: f64,
    #[serde(default)]
    pub caps: bool,
    #[serde(default)]
    pub baseline: f64,
    #[serde(default)]
    pub glow: Option<Glow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Glow {
    pub radius: f64,
    pub color: String,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn finite(v: &[f64]) -> bool {
    v.iter().all(|n| n.is_finite())
}

fn in_bounds(x: f64, y: f64, w: f64, h: f64) -> bool {
    finite(&[x, y, w, h])
        && w >= 0.0
        && h >= 0.0
        && w <= SLIDE_W + 2.0 * MARGIN
        && h <= SLIDE_H + 2.0 * MARGIN
        && x > -MARGIN
        && y > -MARGIN
        && x < SLIDE_W + MARGIN
        && y < SLIDE_H + MARGIN
}

/// Refuse a scene list that is too big or holds numbers that can't be drawn.
pub fn validate(scenes: &[SlideScene]) -> Result<(), String> {
    let bad = |what: &str| {
        Err(format!(
            "The slide layout sent for the export is invalid ({what})."
        ))
    };
    if scenes.len() > MAX_SLIDES {
        return bad("too many slides");
    }
    for s in scenes {
        if s.items.len() > MAX_ITEMS {
            return bad("too many shapes on a slide");
        }
        let mut svg = s.bg_svg.as_ref().map_or(0, String::len);
        let mut text = 0;
        for item in &s.items {
            let ok = match item {
                SceneItem::Shape {
                    x,
                    y,
                    w,
                    h,
                    radius,
                    fill,
                    line,
                    shadow,
                } => {
                    let stops_ok = match fill {
                        Some(Fill::Linear { angle, stops }) => {
                            angle.is_finite()
                                && stops.len() <= 64
                                && stops.iter().all(|s| s.pos.is_finite())
                        }
                        _ => true,
                    };
                    in_bounds(*x, *y, *w, *h)
                        && radius.is_finite()
                        && stops_ok
                        && line.as_ref().is_none_or(|l| {
                            l.width.is_finite() && l.width >= 0.0 && l.width <= 200.0
                        })
                        && shadow.as_ref().is_none_or(|s| {
                            finite(&[s.x, s.y, s.blur])
                                && s.x.abs() <= 500.0
                                && s.y.abs() <= 500.0
                                && (0.0..=500.0).contains(&s.blur)
                        })
                }
                SceneItem::Picture {
                    x,
                    y,
                    w,
                    h,
                    svg: body,
                } => {
                    svg += body.len();
                    in_bounds(*x, *y, *w, *h) && body.len() <= MAX_SVG_BYTES
                }
                SceneItem::Chart { x, y, w, h, index } => in_bounds(*x, *y, *w, *h) && *index < 100,
                SceneItem::Text {
                    x, y, w, h, paras, ..
                } => {
                    let runs_ok = paras.iter().all(|p| {
                        p.line_height.is_finite()
                            && p.line_height >= 0.0
                            && p.line_height <= 2_000.0
                            && p.runs.iter().all(|r| {
                                text += r.text.chars().count();
                                finite(&[r.size, r.weight, r.spacing, r.baseline])
                                    && r.size > 0.0
                                    && r.size <= 2_000.0
                                    && r.spacing.abs() <= 1_000.0
                                    && r.font.len() <= 1_000
                                    && r.glow.as_ref().is_none_or(|g| {
                                        g.radius.is_finite() && (0.0..=500.0).contains(&g.radius)
                                    })
                            })
                    });
                    in_bounds(*x, *y, *w, *h) && runs_ok
                }
            };
            if !ok {
                return bad("a shape is out of range");
            }
        }
        if svg > MAX_SLIDE_SVG_BYTES {
            return bad("pictures too large");
        }
        if text > MAX_TEXT_CHARS {
            return bad("too much text on a slide");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/// `#rrggbb` / `#rrggbbaa` as (`RRGGBB`, alpha in 1/1000 %).
fn color(value: &str) -> Option<(String, i64)> {
    let hex = value.trim().strip_prefix('#')?;
    if !(hex.len() == 6 || hex.len() == 8) || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let alpha = if hex.len() == 8 {
        (u8::from_str_radix(&hex[6..8], 16).ok()? as f64 / 255.0 * 100_000.0).round() as i64
    } else {
        100_000
    };
    Some((hex[..6].to_ascii_uppercase(), alpha))
}

fn srgb(rgb: &str, alpha: i64) -> String {
    if alpha >= 100_000 {
        format!("<a:srgbClr val=\"{rgb}\"/>")
    } else {
        format!("<a:srgbClr val=\"{rgb}\"><a:alpha val=\"{alpha}\"/></a:srgbClr>")
    }
}

fn solid(value: &str) -> Option<String> {
    let (rgb, alpha) = color(value)?;
    (alpha > 0).then(|| format!("<a:solidFill>{}</a:solidFill>", srgb(&rgb, alpha)))
}

fn fill_xml(fill: &Fill) -> Option<String> {
    match fill {
        Fill::Solid { color } => solid(color),
        Fill::Linear { angle, stops } => {
            let gs: String = stops
                .iter()
                .filter_map(|s| {
                    let (rgb, alpha) = color(&s.color)?;
                    let pos = (s.pos.clamp(0.0, 1.0) * 100_000.0).round() as i64;
                    Some(format!("<a:gs pos=\"{pos}\">{}</a:gs>", srgb(&rgb, alpha)))
                })
                .collect();
            if gs.is_empty() {
                return None;
            }
            // CSS: 0deg points up, clockwise. DrawingML: 0 points right.
            let ang = ((angle - 90.0).rem_euclid(360.0) * 60_000.0).round() as i64;
            Some(format!(
                "<a:gradFill rotWithShape=\"1\"><a:gsLst>{gs}</a:gsLst><a:lin ang=\"{ang}\" scaled=\"0\"/></a:gradFill>"
            ))
        }
    }
}

fn geometry(w: f64, h: f64, radius: f64) -> String {
    let short = w.min(h);
    if radius > 0.25 && short > 0.0 {
        let adj = (radius / short * 100_000.0).round().clamp(0.0, 50_000.0) as i64;
        format!("<a:prstGeom prst=\"roundRect\"><a:avLst><a:gd name=\"adj\" fmla=\"val {adj}\"/></a:avLst></a:prstGeom>")
    } else {
        "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>".to_string()
    }
}

#[allow(clippy::too_many_arguments)]
fn shape(
    canvas: &mut Canvas<'_>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    radius: f64,
    fill: Option<&Fill>,
    line: Option<&Line>,
    shadow: Option<&Shadow>,
) {
    let fill = fill.and_then(fill_xml);
    let line = line.and_then(|l| {
        let paint = solid(&l.color)?;
        (l.width > 0.0).then_some((l.width, paint, l.dash))
    });
    if fill.is_none() && line.is_none() {
        return;
    }
    // CSS draws a border inside the box; PowerPoint centres a line on the
    // edge: inset the outline by half the line.
    let inset = line.as_ref().map_or(0.0, |(w, _, _)| w / 2.0);
    let (x, y, w, h) = (
        x + inset,
        y + inset,
        (w - 2.0 * inset).max(0.5),
        (h - 2.0 * inset).max(0.5),
    );
    let radius = (radius - inset).max(0.0);
    let ln = match &line {
        Some((width, paint, dash)) => format!(
            "<a:ln w=\"{}\">{paint}{}</a:ln>",
            emu(*width),
            if *dash {
                "<a:prstDash val=\"dash\"/>"
            } else {
                ""
            }
        ),
        None => "<a:ln><a:noFill/></a:ln>".to_string(),
    };
    let fill = fill.unwrap_or_else(|| "<a:noFill/>".to_string());
    let geom = geometry(w, h, radius);
    // CSS's blur length and DrawingML's blurRad are both twice the Gaussian's
    // deviation; the offset becomes a distance and a direction.
    let effect = shadow
        .and_then(|s| {
            let (rgb, alpha) = color(&s.color)?;
            let dir = (s.y.atan2(s.x).to_degrees().rem_euclid(360.0) * 60_000.0).round() as i64;
            Some(format!(
                "<a:effectLst><a:outerShdw blurRad=\"{}\" dist=\"{}\" dir=\"{dir}\" algn=\"ctr\" rotWithShape=\"0\">{}</a:outerShdw></a:effectLst>",
                emu(s.blur),
                emu(s.x.hypot(s.y)),
                srgb(&rgb, alpha)
            ))
        })
        .unwrap_or_default();
    canvas.raw(|id| {
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Shape {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>\
             <p:spPr>{}{geom}{fill}{ln}{effect}</p:spPr>\
             <p:txBody><a:bodyPr rtlCol=\"0\" anchor=\"ctr\"/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\" dirty=\"0\"/></a:p></p:txBody></p:sp>",
            xfrm(x, y, w, h)
        )
    });
}

/// The `index`-th drawn chart's spec in the slide's HTML.
fn chart_spec(html: &str, index: usize) -> Option<slide_charts::ChartSpec> {
    let mut n = 0;
    for tok in slide_html::scan(html) {
        let TokKind::Open { name, .. } = &tok.kind else {
            continue;
        };
        if name != "svg" {
            continue;
        }
        let attrs = slide_html::parse_attrs(&html[tok.range.clone()]);
        if !attrs.iter().any(|a| a.name == "data-chart") {
            continue;
        }
        if n == index {
            return slide_charts::stored_spec(&html[tok.range.start..]);
        }
        n += 1;
    }
    None
}

fn run_props(r: &Run, text: &str) -> String {
    let (face, bold) = face_for(&r.font, r.weight);
    let lang = run_lang(text).unwrap_or("en-US");
    let mut attrs = format!(
        "lang=\"{lang}\" sz=\"{}\" b=\"{}\" i=\"{}\"",
        hundredths(r.size).clamp(100, 400_000),
        u8::from(bold),
        u8::from(r.italic)
    );
    if r.underline {
        attrs.push_str(" u=\"sng\"");
    }
    if r.strike {
        attrs.push_str(" strike=\"sngStrike\"");
    }
    if r.spacing.abs() >= 0.01 {
        attrs.push_str(&format!(
            " spc=\"{}\"",
            hundredths(r.spacing).clamp(-400_000, 400_000)
        ));
    }
    if r.caps {
        attrs.push_str(" cap=\"all\"");
    }
    if r.baseline.abs() >= 1.0 {
        attrs.push_str(&format!(
            " baseline=\"{}\"",
            (r.baseline * 1000.0).round() as i64
        ));
    }
    let fill = solid(&r.color).unwrap_or_else(|| "<a:noFill/>".to_string());
    let effect = r
        .glow
        .as_ref()
        .and_then(|g| {
            // A CSS text-shadow's blur spreads its colour thinly; PowerPoint's
            // glow is a denser halo. A quarter of the blur at 60% of the
            // alpha looked closest side by side.
            let (rgb, alpha) = color(&g.color)?;
            Some(format!(
                "<a:effectLst><a:glow rad=\"{}\">{}</a:glow></a:effectLst>",
                emu(g.radius * 0.25),
                srgb(&rgb, (alpha as f64 * 0.6).round() as i64)
            ))
        })
        .unwrap_or_default();
    let face = esc(&face);
    format!(
        "<a:rPr {attrs} dirty=\"0\">{fill}{effect}<a:latin typeface=\"{face}\"/><a:cs typeface=\"{face}\"/></a:rPr>"
    )
}

fn para_xml(p: &Para) -> String {
    let algn = match p.align.as_str() {
        "ctr" => "ctr",
        "r" => "r",
        "just" => "just",
        _ => "l",
    };
    let mut out = format!(
        "<a:p><a:pPr algn=\"{algn}\" marL=\"0\" indent=\"0\"><a:lnSpc><a:spcPts val=\"{}\"/></a:lnSpc>\
         <a:spcBef><a:spcPts val=\"0\"/></a:spcBef><a:spcAft><a:spcPts val=\"0\"/></a:spcAft><a:buNone/></a:pPr>",
        hundredths(p.line_height).clamp(0, 158_400)
    );
    for r in &p.runs {
        for (i, piece) in r.text.split('\n').enumerate() {
            if i > 0 {
                out.push_str(&format!("<a:br>{}</a:br>", run_props(r, piece)));
            }
            if !piece.is_empty() {
                out.push_str(&format!(
                    "<a:r>{}<a:t>{}</a:t></a:r>",
                    run_props(r, piece),
                    esc(piece)
                ));
            }
        }
    }
    if let Some(last) = p.runs.last() {
        let (face, _) = face_for(&last.font, last.weight);
        out.push_str(&format!(
            "<a:endParaRPr lang=\"en-US\" sz=\"{}\" dirty=\"0\"><a:latin typeface=\"{}\"/></a:endParaRPr>",
            hundredths(last.size).clamp(100, 400_000),
            esc(&face)
        ));
    }
    out.push_str("</a:p>");
    out
}

/// Extra width for a text box, so PowerPoint doesn't wrap a line the browser
/// kept whole (glyph widths round a little differently). Kept small: more
/// room lets PowerPoint pull the next word up where the browser wrapped.
fn slack(w: f64, size: f64) -> f64 {
    (w * 0.006 + size * 0.1).min(24.0)
}

/// How far to move a text box down so PowerPoint's first baseline lands on
/// the browser's. CSS centres the font's ascent + descent in each line box,
/// so the baseline sits at L/2 + (ascent - descent)/2 x size; PowerPoint,
/// with exact spacing, puts it about 0.78 L down. Checked on the lab decks
/// (Segoe UI, Georgia, Cascadia; 24-168 px; line heights 1.04-1.5): within
/// 2 px.
fn baseline_shift(line_height: f64, size: f64, font: &str) -> f64 {
    let (ascent, descent) = vertical_metrics(font);
    (ascent - descent) / 2.0 * size - 0.28 * line_height
}

/// Draw `scene` onto an empty canvas. `html` is the slide's stored HTML (for
/// chart specs).
pub(crate) fn draw(canvas: &mut Canvas<'_>, scene: &SlideScene, html: &str) {
    let master_bg = canvas.theme.bg.clone();
    let drew_bg = scene
        .bg_svg
        .as_deref()
        .is_some_and(|svg| canvas.background_picture(svg));
    if !drew_bg {
        if let Some((rgb, _)) = color(&scene.bg).filter(|(rgb, _)| *rgb != master_bg) {
            canvas.background_color(&rgb);
        }
    }
    for item in &scene.items {
        match item {
            SceneItem::Shape {
                x,
                y,
                w,
                h,
                radius,
                fill,
                line,
                shadow,
            } => {
                shape(
                    canvas,
                    *x,
                    *y,
                    *w,
                    *h,
                    *radius,
                    fill.as_ref(),
                    line.as_ref(),
                    shadow.as_ref(),
                );
            }
            SceneItem::Picture { x, y, w, h, svg } => {
                if *w >= 1.0 && *h >= 1.0 {
                    canvas.picture_exact(svg, *x, *y, *w, *h);
                }
            }
            SceneItem::Chart { x, y, w, h, index } => {
                if let Some(spec) = chart_spec(html, *index) {
                    canvas.chart(ChartData::from_spec(&spec), *x, *y, *w, *h);
                }
            }
            SceneItem::Text {
                x,
                y,
                w,
                h,
                title,
                paras,
            } => {
                if paras
                    .iter()
                    .all(|p| p.runs.iter().all(|r| r.text.trim().is_empty()))
                {
                    continue;
                }
                let first = &paras[0];
                let size = first.runs.first().map_or(16.0, |r| r.size);
                let extra = slack(*w, size);
                let x = match first.align.as_str() {
                    "ctr" => x - extra / 2.0,
                    "r" => x - extra,
                    _ => *x,
                };
                let font = first.runs.first().map_or("", |r| r.font.as_str());
                let y = y + baseline_shift(first.line_height, size, font);
                let body: String = paras.iter().map(para_xml).collect();
                let name = if *title { "Title" } else { "Text" };
                canvas.text_box(name, x, y, w + extra, h.max(1.0), &body, *title);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(items: serde_json::Value) -> SlideScene {
        serde_json::from_value(
            serde_json::json!({ "id": "s", "bg": "#0c0d12ff", "bgSvg": null, "items": items }),
        )
        .expect("scene json")
    }

    #[test]
    fn colours_carry_alpha() {
        assert_eq!(color("#ff7a59ff"), Some(("FF7A59".into(), 100_000)));
        assert_eq!(color("#a9a7b3cc"), Some(("A9A7B3".into(), 80_000)));
        assert_eq!(color("#123456"), Some(("123456".into(), 100_000)));
        assert_eq!(color("red"), None);
        assert!(srgb("FF0000", 50_000).contains("<a:alpha val=\"50000\"/>"));
    }

    #[test]
    fn linear_fills_turn_css_angles_into_drawingml() {
        let f = Fill::Linear {
            angle: 180.0,
            stops: vec![
                Stop {
                    pos: 0.0,
                    color: "#ffffffff".into(),
                },
                Stop {
                    pos: 1.0,
                    color: "#00000080".into(),
                },
            ],
        };
        let xml = fill_xml(&f).unwrap();
        assert!(xml.contains("<a:lin ang=\"5400000\""), "{xml}");
        assert!(
            xml.contains("<a:gs pos=\"100000\"><a:srgbClr val=\"000000\"><a:alpha val=\"50196\"/>")
        );
    }

    #[test]
    fn validation_refuses_what_cannot_be_drawn() {
        let ok = scene(
            serde_json::json!([{ "kind": "shape", "x": 1, "y": 2, "w": 3, "h": 4, "radius": 0, "fill": null, "line": null }]),
        );
        assert!(validate(&[ok]).is_ok());
        let far = scene(
            serde_json::json!([{ "kind": "shape", "x": 1e9, "y": 2, "w": 3, "h": 4, "radius": 0, "fill": null, "line": null }]),
        );
        assert!(validate(&[far]).is_err());
        let huge = scene(
            serde_json::json!([{ "kind": "text", "x": 0, "y": 0, "w": 10, "h": 10, "paras": [
            { "align": "l", "lineHeight": 40, "runs": [{ "text": "x", "font": "Arial", "size": 1e6, "weight": 400, "color": "#000000ff" }] }
        ] }]),
        );
        assert!(validate(&[huge]).is_err());
        let many = SlideScene {
            id: "s".into(),
            bg: "#fff".into(),
            bg_svg: None,
            items: Vec::new(),
        };
        assert!(validate(&vec![many; MAX_SLIDES + 1]).is_err());
    }

    #[test]
    fn text_keeps_runs_breaks_and_spacing() {
        let p: Para = serde_json::from_value(serde_json::json!({
            "align": "ctr", "lineHeight": 62.4, "runs": [
                { "text": "Checkout\noutage", "font": "Georgia, serif", "size": 48, "weight": 700, "color": "#f4f1ecff", "spacing": -1.2 },
                { "text": " にほん", "font": "Georgia", "size": 48, "weight": 400, "italic": true, "color": "#ff7a5980", "caps": true,
                  "glow": { "radius": 80, "color": "#ff7a5959" } }
            ]
        }))
        .unwrap();
        let xml = para_xml(&p);
        assert!(
            xml.contains("algn=\"ctr\"") && xml.contains("<a:spcPts val=\"3120\"/>"),
            "{xml}"
        );
        assert!(
            xml.contains("<a:br>")
                && xml.contains(">Checkout</a:t>")
                && xml.contains(">outage</a:t>")
        );
        assert!(xml.contains("sz=\"2400\" b=\"1\"") && xml.contains("spc=\"-60\""));
        assert!(
            xml.contains("lang=\"ja-JP\"")
                && xml.contains("cap=\"all\"")
                && xml.contains("i=\"1\"")
        );
        assert!(xml.contains("<a:glow rad=\"127000\">"));
    }

    /// Fidelity lab: for every `<name>.json` deck in `$PPTX_LAB` with a
    /// `<name>.scene.json` beside it, write `<name>.pptx`.
    #[test]
    #[ignore]
    fn lab_build() {
        let Ok(dir) = std::env::var("PPTX_LAB") else {
            return;
        };
        // Sample decks covering every layout, in the themes of two real decks.
        for (name, theme_from) in [("sample-ink", "real2.json"), ("sample-paper", "real1.json")] {
            let path = std::path::Path::new(&dir).join(format!("{name}.json"));
            let Ok(src) = std::fs::read_to_string(std::path::Path::new(&dir).join(theme_from))
            else {
                continue;
            };
            let theme: serde_json::Value = serde_json::from_str(&src).unwrap();
            let s = |id: &str, layout: &str, f: serde_json::Value| {
                let l = crate::slide_layouts::Layout::parse(layout).unwrap();
                let f =
                    crate::slide_layouts::validate(l, &serde_json::from_value(f).unwrap()).unwrap();
                serde_json::json!({ "id": id, "position": 0, "layout": layout, "html": crate::slide_layouts::render(l, &f).unwrap(), "notes": "", "slots": [] })
            };
            let slides = vec![
                s(
                    "t",
                    "title",
                    serde_json::json!({"kicker": "Quarterly review", "headline": "Q3: growth <span class=\"accent\">without</span> the burn", "sub": "Ferry Labs, November 2026"}),
                ),
                s(
                    "q",
                    "quote",
                    serde_json::json!({"quote": "It's the first tool our whole team actually opens every day.", "cite": "Head of Operations, Acme"}),
                ),
                s(
                    "sec",
                    "section",
                    serde_json::json!({"kicker": "Part two", "headline": "Where we go next"}),
                ),
                s(
                    "c",
                    "chart",
                    serde_json::json!({"kicker": "Revenue", "headline": "Revenue by quarter, 2025 vs 2026", "chart": {"type": "bar", "categories": ["Q1", "Q2", "Q3", "Q4"], "series": [{"name": "2025", "values": [8, 9, 9.4, 10.2]}, {"name": "2026", "values": [9.6, 10.8, 12.1, 13]}], "unit_prefix": "$", "unit_suffix": "M"}, "footnote": "Q4 2026 is a forecast."}),
                ),
                s(
                    "l",
                    "chart",
                    serde_json::json!({"headline": "Active users keep climbing", "chart": {"type": "line", "categories": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], "series": [{"name": "Users", "values": [1200, 1350, 1500, 1720, 1900, 2150]}]}}),
                ),
                s(
                    "tc",
                    "two-col",
                    serde_json::json!({"kicker": "Process", "headline": "Before and after automation", "columns": [{"kicker": "Before", "body": "Reports were assembled by hand every Friday, often late and with errors."}, {"kicker": "After", "bullets": ["Generated every morning", "Checked automatically", "Shared in one click"]}]}),
                ),
                serde_json::json!({ "id": "cu", "position": 0, "layout": "custom", "notes": "", "slots": [], "html": "<h2 class=\"headline\">A custom slide</h2><div style=\"display:flex;gap:40px\"><div style=\"flex:1;padding:40px;border-radius:32px;background:linear-gradient(135deg,var(--accent),#7b5cff);color:#fff\"><p style=\"font-size:56px;font-weight:700\">3×</p><p>faster reviews</p></div><div style=\"flex:1;padding:40px;border:4px dashed var(--accent);border-radius:32px\"><p style=\"font-size:56px;font-weight:700\">−40%</p><p>open defects</p></div></div>" }),
            ];
            let mut deck = theme.clone();
            deck["title"] = serde_json::json!(name);
            deck["slides"] = serde_json::json!(slides);
            std::fs::write(&path, serde_json::to_string_pretty(&deck).unwrap()).unwrap();
        }
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let Some(stem) = name
                .strip_suffix(".json")
                .filter(|s| !s.ends_with(".scene"))
            else {
                continue;
            };
            let scene_path = path.with_file_name(format!("{stem}.scene.json"));
            let Ok(scene_json) = std::fs::read_to_string(&scene_path) else {
                continue;
            };
            let deck: provider_core::schema::DeckDetail =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let scenes: Vec<SlideScene> = serde_json::from_str(&scene_json).unwrap();
            let bytes = crate::deck_pptx::build(&deck, Some(&scenes)).unwrap();
            std::fs::write(path.with_file_name(format!("{stem}.pptx")), bytes).unwrap();
            let plain = crate::deck_pptx::build(&deck, None).unwrap();
            std::fs::write(path.with_file_name(format!("{stem}.old.pptx")), plain).unwrap();
            println!("{stem}: ok");
        }
        for f in [
            "Segoe UI Variable Display",
            "Segoe UI Variable Text",
            "Cascadia Code",
            "Georgia",
        ] {
            println!(
                "{f}: {:?} / 650 {:?}",
                face_for(f, 400.0),
                face_for(f, 650.0)
            );
        }
    }

    #[test]
    fn charts_are_found_by_index() {
        let spec = serde_json::json!({ "type": "bar", "categories": ["Q1", "Q2"], "series": [{ "name": "2026", "values": [1, 2] }] });
        let one = slide_charts::render(
            &slide_charts::parse_spec(&spec).unwrap(),
            slide_charts::PictureBox {
                width: 800.0,
                height: 400.0,
            },
        )
        .unwrap();
        let html = format!("<h2>x</h2><svg viewBox=\"0 0 1 1\"></svg>{one}");
        assert!(chart_spec(&html, 0).is_some());
        assert!(chart_spec(&html, 1).is_none());
    }
}
