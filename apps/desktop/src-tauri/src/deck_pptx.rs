//! Slides export to PowerPoint: a deck as a real, editable .pptx.
//!
//! Written by hand on `zip`, like the Word export. A typed slide is read back
//! into its fields (`slide_layouts::reconstruct`) and laid out the way its
//! theme draws it: the headline is the slide's title placeholder, every other
//! field a text box in the theme's colours and fonts, bullets real bullets,
//! stats and columns their own boxes, a chart a native chart over an embedded
//! workbook (so PowerPoint's "Edit Data" works), a model-drawn picture an SVG
//! with a PNG fallback. Speaker notes become PowerPoint notes.
//!
//! A custom slide (the model's own HTML), or a typed slide whose HTML was
//! edited by hand, has no fields to read: it becomes its heading as the title
//! and its visible text as one text box, plus its first picture.
//!
//! Text is measured with generous per-character widths (no font metrics
//! here), so a box is tall enough for its text in the fonts PowerPoint uses.

use std::io::{Cursor, Write};

use provider_core::schema::{DeckDetail, DeckSlide};

use crate::deck_pptx_parts::{
    self as parts, emu, esc, hundredths, ChartData, Theme, NS_A, NS_P, NS_R, REL, SLIDE_H, SLIDE_W,
    XML_DECL,
};
use crate::deck_pptx_scene::SlideScene;
use crate::slide_charts;
use crate::slide_html::{self, TokKind};
use crate::slide_layouts::{self, Layout, SlideFields};

/// The .pptx bytes for `deck`. A slide with a scene (what the deck frame
/// measured on the drawn slide, `deck_pptx_scene`) is placed exactly as
/// drawn; a slide without one is rebuilt from its fields.
pub fn build(deck: &DeckDetail, scenes: Option<&[SlideScene]>) -> Result<Vec<u8>, String> {
    if let Some(scenes) = scenes {
        crate::deck_pptx_scene::validate(scenes)?;
    }
    let theme = Theme::from_css(&deck.theme_css);
    let mut package = Package::default();
    for (i, slide) in deck.slides.iter().enumerate() {
        let scene = scenes.and_then(|list| list.iter().find(|s| s.id == slide.id));
        package.add_slide(i + 1, slide, &theme, scene)?;
    }
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    package
        .finish(&deck.title, &theme, &now)
        .map_err(|e| format!("Couldn't build the PowerPoint file: {e}"))
}

// ---------------------------------------------------------------------------
// Inline text
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Inline {
    bold: bool,
    italic: bool,
    underline: bool,
    accent: bool,
    /// Percent: 30 superscript, -25 subscript.
    baseline: i32,
    small: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum Piece {
    Text(String, Inline),
    Break,
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let Some(semi) = after.find(';').filter(|&i| i <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let name = &after[..semi];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16)
                .ok()
                .and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A text field's inline HTML (the slot subset: `span em strong b i u br sub
/// sup small mark`, `class="accent"`) as styled pieces.
fn inline_pieces(html: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut stack: Vec<(String, Inline)> = Vec::new();
    let mut style = Inline::default();
    let mut at = 0;
    let push_text = |out: &mut Vec<Piece>, raw: &str, style: Inline| {
        let text = decode_entities(raw).replace(['\n', '\r', '\t'], " ");
        if !text.is_empty() {
            out.push(Piece::Text(text, style));
        }
    };
    for tok in slide_html::scan(html) {
        push_text(&mut out, &html[at..tok.range.start], style);
        at = tok.range.end;
        match &tok.kind {
            TokKind::Open { name, self_closing } => {
                if name == "br" {
                    out.push(Piece::Break);
                    continue;
                }
                if *self_closing || slide_html::is_void(name) {
                    continue;
                }
                let tag = &html[tok.range.clone()];
                let accent = slide_html::parse_attrs(tag).iter().any(|a| {
                    a.name == "class"
                        && a.value
                            .as_deref()
                            .unwrap_or("")
                            .split_whitespace()
                            .any(|c| c == "accent")
                });
                stack.push((name.clone(), style));
                match name.as_str() {
                    "strong" | "b" => style.bold = true,
                    "em" | "i" => style.italic = true,
                    "u" => style.underline = true,
                    "mark" => style.accent = true,
                    "sup" => style.baseline = 30,
                    "sub" => style.baseline = -25,
                    "small" => style.small = true,
                    _ => {}
                }
                if accent {
                    style.accent = true;
                }
            }
            TokKind::Close { name } => {
                if let Some(pos) = stack.iter().rposition(|(n, _)| n == name) {
                    style = stack[pos].1;
                    stack.truncate(pos);
                }
            }
            TokKind::Comment => {}
        }
    }
    push_text(&mut out, &html[at..], style);
    trim_pieces(out)
}

/// Leading and trailing whitespace of the whole run of pieces removed.
fn trim_pieces(mut pieces: Vec<Piece>) -> Vec<Piece> {
    if let Some(Piece::Text(t, _)) = pieces.first_mut() {
        *t = t.trim_start().to_string();
    }
    if let Some(Piece::Text(t, _)) = pieces.last_mut() {
        *t = t.trim_end().to_string();
    }
    pieces.retain(|p| !matches!(p, Piece::Text(t, _) if t.is_empty()));
    pieces
}

fn plain(text: &str) -> Vec<Piece> {
    vec![Piece::Text(text.to_string(), Inline::default())]
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6)
}

/// Estimated width of `text` in ems.
fn text_ems(text: &str, caps: bool, spacing_em: f64) -> f64 {
    text.chars()
        .map(|c| {
            let w = if is_wide(c) {
                1.0
            } else if c == ' ' {
                0.3
            } else if caps || c.is_uppercase() || c.is_ascii_digit() {
                0.64
            } else if "il.,:;'|!".contains(c) {
                0.3
            } else {
                0.54
            };
            w + spacing_em
        })
        .sum()
}

// ---------------------------------------------------------------------------
// Text boxes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Font {
    Display,
    Body,
    Mono,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Color {
    Ink,
    Ink2,
    Accent,
}

/// How one text field is drawn: a theme component (`.headline`, `.sub`, …).
#[derive(Debug, Clone, Copy)]
struct Style {
    font: Font,
    size: f64,
    line_height: f64,
    ink: Color,
    bold: bool,
    caps: bool,
    spacing_em: f64,
    /// Percent opacity, when less than 100.
    alpha: Option<u32>,
}

impl Style {
    const fn new(font: Font, size: f64, line_height: f64, ink: Color) -> Style {
        Style {
            font,
            size,
            line_height,
            ink,
            bold: false,
            caps: false,
            spacing_em: 0.0,
            alpha: None,
        }
    }
    const fn bold(mut self) -> Style {
        self.bold = true;
        self
    }
    const fn size(mut self, size: f64) -> Style {
        self.size = size;
        self
    }
}

const KICKER: Style = Style {
    caps: true,
    spacing_em: 0.16,
    ..Style::new(Font::Mono, 28.0, 1.3, Color::Accent).bold()
};
const HEADLINE: Style = Style::new(Font::Display, 104.0, 1.04, Color::Ink).bold();
const SUB: Style = Style::new(Font::Body, 48.0, 1.3, Color::Ink2);
const BODY: Style = Style::new(Font::Body, 40.0, 1.5, Color::Ink2);
const BULLET: Style = Style::new(Font::Body, 44.0, 1.3, Color::Ink);
const STAT_VALUE: Style = Style::new(Font::Display, 168.0, 1.0, Color::Accent).bold();
const STAT_LABEL: Style = Style::new(Font::Body, 36.0, 1.3, Color::Ink2);
const QUOTE: Style = Style::new(Font::Display, 76.0, 1.18, Color::Ink);
const CITE: Style = Style {
    spacing_em: 0.06,
    ..Style::new(Font::Mono, 30.0, 1.3, Color::Ink2)
};
const FOOTNOTE: Style = Style {
    spacing_em: 0.04,
    alpha: Some(80),
    ..Style::new(Font::Mono, 24.0, 1.3, Color::Ink2)
};
/// Space between bullets.
const BULLET_GAP: f64 = 28.0;
/// Bullet indent (the marker sits in it).
const BULLET_INDENT: f64 = 56.0;

/// One paragraph: its pieces and whether it is a bullet.
struct Para {
    pieces: Vec<Piece>,
    bullet: bool,
}

/// Paragraphs laid out in a box: their XML and the height they need.
struct TextBlock {
    xml: String,
    height: f64,
}

/// The script a run is in, for its language tag: CJK text needs one so
/// PowerPoint picks the theme's face for that script.
pub(crate) fn run_lang(text: &str) -> Option<&'static str> {
    let mut han = false;
    for c in text.chars() {
        match c as u32 {
            0x3040..=0x30FF => return Some("ja-JP"),
            0x1100..=0x11FF | 0xAC00..=0xD7AF => return Some("ko-KR"),
            0x4E00..=0x9FFF => han = true,
            _ => {}
        }
    }
    han.then_some("zh-CN")
}

impl Theme {
    fn ink(&self, ink: Color) -> &str {
        match ink {
            Color::Ink => &self.ink,
            Color::Ink2 => &self.ink2,
            Color::Accent => &self.accent,
        }
    }
}

fn run_xml(text: &str, inline: Inline, style: &Style, theme: &Theme) -> String {
    let size = if inline.small {
        style.size * 0.8
    } else {
        style.size
    };
    // Bold text wears the main ink, as the theme's `strong` does.
    let color = if inline.accent {
        theme.ink(Color::Accent)
    } else if inline.bold && !style.bold {
        theme.ink(Color::Ink)
    } else {
        theme.ink(style.ink)
    };
    let mut attrs = format!(" sz=\"{}\"", hundredths(size));
    if let Some(lang) = run_lang(text) {
        attrs.push_str(&format!(" lang=\"{lang}\" altLang=\"en-US\""));
    } else {
        attrs.push_str(" lang=\"en-US\"");
    }
    if style.bold || inline.bold {
        attrs.push_str(" b=\"1\"");
    }
    if inline.italic {
        attrs.push_str(" i=\"1\"");
    }
    if inline.underline {
        attrs.push_str(" u=\"sng\"");
    }
    if style.caps {
        attrs.push_str(" cap=\"all\"");
    }
    if style.spacing_em > 0.0 {
        attrs.push_str(&format!(" spc=\"{}\"", hundredths(style.spacing_em * size)));
    }
    if inline.baseline != 0 {
        attrs.push_str(&format!(" baseline=\"{}\"", inline.baseline * 1000));
    }
    let alpha = style
        .alpha
        .map(|a| format!("<a:alpha val=\"{}\"/>", a * 1000))
        .unwrap_or_default();
    let faces = match style.font {
        Font::Display => {
            "<a:latin typeface=\"+mj-lt\"/><a:ea typeface=\"+mj-ea\"/><a:cs typeface=\"+mj-cs\"/>"
                .to_string()
        }
        Font::Body => {
            "<a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/>"
                .to_string()
        }
        Font::Mono => format!(
            "<a:latin typeface=\"{0}\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"{0}\"/>",
            esc(&theme.font_mono)
        ),
    };
    format!(
        "<a:r><a:rPr{attrs} dirty=\"0\"><a:solidFill><a:srgbClr val=\"{color}\">{alpha}</a:srgbClr></a:solidFill>{faces}</a:rPr><a:t>{}</a:t></a:r>",
        esc(text)
    )
}

/// Lay out `paras` in a box `width` wide.
fn text_block(paras: &[Para], style: &Style, width: f64, theme: &Theme) -> TextBlock {
    let mut xml = String::new();
    let mut lines = 0.0;
    let mut gaps = 0.0;
    // CSS line-height is a multiple of the font size; PowerPoint's 100% is 1.2.
    let line_pct = (style.line_height / 1.2 * 100_000.0).round() as i64;
    for (i, para) in paras.iter().enumerate() {
        let text_width = if para.bullet {
            width - BULLET_INDENT
        } else {
            width
        };
        // Lines between breaks, each wrapped to the width (with slack for
        // word wrapping).
        let mut segment = String::new();
        let mut segments = Vec::new();
        for piece in &para.pieces {
            match piece {
                Piece::Text(t, _) => segment.push_str(t),
                Piece::Break => segments.push(std::mem::take(&mut segment)),
            }
        }
        segments.push(segment);
        for seg in &segments {
            let ems = text_ems(seg, style.caps, style.spacing_em) * 1.08;
            lines += (ems * style.size / text_width).ceil().max(1.0);
        }

        let mut ppr = String::from("<a:pPr algn=\"l\"");
        if para.bullet {
            ppr.push_str(&format!(
                " marL=\"{}\" indent=\"{}\"",
                emu(BULLET_INDENT),
                -emu(BULLET_INDENT)
            ));
        } else {
            ppr.push_str(" marL=\"0\" indent=\"0\"");
        }
        ppr.push_str(&format!(
            "><a:lnSpc><a:spcPct val=\"{line_pct}\"/></a:lnSpc>"
        ));
        if para.bullet && i > 0 {
            ppr.push_str(&format!(
                "<a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>",
                hundredths(BULLET_GAP)
            ));
            gaps += BULLET_GAP;
        } else {
            ppr.push_str("<a:spcBef><a:spcPts val=\"0\"/></a:spcBef>");
        }
        if para.bullet {
            ppr.push_str(&format!(
                "<a:buClr><a:srgbClr val=\"{}\"/></a:buClr><a:buSzPct val=\"60000\"/><a:buFont typeface=\"Arial\"/><a:buChar char=\"&#9632;\"/>",
                theme.accent
            ));
        } else {
            ppr.push_str("<a:buNone/>");
        }
        ppr.push_str("</a:pPr>");
        xml.push_str("<a:p>");
        xml.push_str(&ppr);
        for piece in &para.pieces {
            match piece {
                Piece::Text(t, inline) => xml.push_str(&run_xml(t, *inline, style, theme)),
                Piece::Break => xml.push_str(&format!(
                    "<a:br><a:rPr lang=\"en-US\" sz=\"{}\" dirty=\"0\"/></a:br>",
                    hundredths(style.size)
                )),
            }
        }
        xml.push_str(&format!(
            "<a:endParaRPr lang=\"en-US\" sz=\"{}\" dirty=\"0\"/></a:p>",
            hundredths(style.size)
        ));
    }
    TextBlock {
        xml,
        height: lines * style.size * style.line_height + gaps,
    }
}

fn one(pieces: Vec<Piece>) -> Vec<Para> {
    vec![Para {
        pieces,
        bullet: false,
    }]
}

fn bullets(items: &[String]) -> Vec<Para> {
    items
        .iter()
        .map(|item| Para {
            pieces: inline_pieces(item),
            bullet: true,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// One slide's shapes
// ---------------------------------------------------------------------------

/// What one slide refers to outside its own XML.
pub(crate) enum Media {
    Chart(ChartData),
    /// A standalone svg and its PNG fallback.
    Picture {
        svg: String,
        png: Vec<u8>,
    },
}

pub(crate) struct Canvas<'t> {
    pub(crate) theme: &'t Theme,
    shapes: String,
    next_id: u32,
    media: Vec<Media>,
    has_title: bool,
    /// The slide's own `<p:bg>`, when it differs from the master's.
    bg: Option<String>,
}

impl<'t> Canvas<'t> {
    fn new(theme: &'t Theme) -> Self {
        Canvas {
            theme,
            shapes: String::new(),
            next_id: 2,
            media: Vec::new(),
            has_title: false,
            bg: None,
        }
    }

    fn id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// A text box; the first one marked `title` is the slide's title
    /// placeholder (the slide's name in PowerPoint's outline and for screen
    /// readers).
    fn text(&mut self, name: &str, x: f64, y: f64, w: f64, block: &TextBlock, title: bool) {
        // A little extra height: PowerPoint's line boxes run taller than CSS's.
        let h = (block.height * 1.06).max(1.0);
        self.text_box(name, x, y, w, h, &block.xml, title);
    }

    /// A text box holding `paras` (`<a:p>` elements) at an exact box.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn text_box(
        &mut self,
        name: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        paras: &str,
        title: bool,
    ) {
        let id = self.id();
        let title = title && !self.has_title;
        self.has_title |= title;
        let nv = if title {
            format!(
                "<p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Title {id}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"title\"/></p:nvPr></p:nvSpPr>"
            )
        } else {
            format!(
                "<p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{} {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>",
                esc(name)
            )
        };
        self.shapes.push_str(&format!(
            "<p:sp>{nv}<p:spPr>{}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>\
             <p:txBody><a:bodyPr wrap=\"square\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" anchor=\"t\" rtlCol=\"0\"><a:noAutofit/></a:bodyPr><a:lstStyle/>{}</p:txBody></p:sp>",
            xfrm(x, y, w, h),
            paras
        ));
    }

    /// A shape's XML (`<p:sp>` and the like) as is; `id` gives it a number.
    pub(crate) fn raw(&mut self, xml: impl FnOnce(u32) -> String) {
        let id = self.id();
        let xml = xml(id);
        self.shapes.push_str(&xml);
    }

    /// A filled (optionally rounded) rectangle: an accent bar or a card.
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, color: &str, radius: f64) {
        let id = self.id();
        let geom = if radius > 0.0 {
            let adj = (radius / w.min(h) * 100_000.0).round().min(50_000.0) as i64;
            format!("<a:prstGeom prst=\"roundRect\"><a:avLst><a:gd name=\"adj\" fmla=\"val {adj}\"/></a:avLst></a:prstGeom>")
        } else {
            "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>".to_string()
        };
        self.shapes.push_str(&format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Shape {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>\
             <p:spPr>{}{geom}<a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>\
             <p:txBody><a:bodyPr rtlCol=\"0\" anchor=\"ctr\"/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\" dirty=\"0\"/></a:p></p:txBody></p:sp>",
            xfrm(x, y, w, h)
        ));
    }

    /// A native chart filling the box.
    pub(crate) fn chart(&mut self, data: ChartData, x: f64, y: f64, w: f64, h: f64) {
        let id = self.id();
        self.media.push(Media::Chart(data));
        let rid = media_rid(self.media.len());
        self.shapes.push_str(&format!(
            "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"Chart {id}\"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>\
             <p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm>\
             <a:graphic><a:graphicData uri=\"{c}\"><c:chart xmlns:c=\"{c}\" r:id=\"{rid}\"/></a:graphicData></a:graphic></p:graphicFrame>",
            emu(x),
            emu(y),
            emu(w),
            emu(h),
            c = parts::NS_C
        ));
    }

    /// A standalone svg as a picture filling the box exactly. Returns false
    /// when it can't be drawn.
    pub(crate) fn picture_exact(&mut self, svg: &str, x: f64, y: f64, w: f64, h: f64) -> bool {
        let svg = parts::standalone_svg(svg, self.theme);
        let Ok(png) = parts::svg_to_png(&svg, w.round().clamp(1.0, 3840.0) as u32) else {
            return false;
        };
        let id = self.id();
        self.media.push(Media::Picture { svg, png });
        self.shapes
            .push_str(&picture_xml(id, self.media.len(), x, y, w, h));
        true
    }

    /// A standalone svg as the slide's background picture.
    pub(crate) fn background_picture(&mut self, svg: &str) -> bool {
        let svg = parts::standalone_svg(svg, self.theme);
        let Ok(png) = parts::svg_to_png(&svg, SLIDE_W as u32) else {
            return false;
        };
        self.media.push(Media::Picture { svg, png });
        let n = self.media.len();
        self.bg = Some(format!(
            "<p:bg><p:bgPr><a:blipFill dpi=\"0\" rotWithShape=\"1\"><a:blip r:embed=\"{}\">{}</a:blip><a:srcRect/>\
             <a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>",
            media_rid(n),
            svg_ext(n)
        ));
        true
    }

    /// A solid slide background (`RRGGBB`).
    pub(crate) fn background_color(&mut self, color: &str) {
        self.bg = Some(format!(
            "<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>"
        ));
    }

    /// An svg picture fitted (aspect kept) and centred in the box. Returns
    /// false when the svg can't be drawn, so the caller can fall back.
    fn picture(&mut self, svg: &str, x: f64, y: f64, w: f64, h: f64) -> bool {
        let svg = parts::standalone_svg(svg, self.theme);
        let aspect = parts::svg_aspect(&svg).unwrap_or(w / h);
        let (pw, ph) = if w / h > aspect {
            (h * aspect, h)
        } else {
            (w, w / aspect)
        };
        let Ok(png) = parts::svg_to_png(&svg, pw.round().max(1.0) as u32) else {
            return false;
        };
        let id = self.id();
        self.media.push(Media::Picture { svg, png });
        let n = self.media.len();
        self.shapes.push_str(&picture_xml(
            id,
            n,
            x + (w - pw) / 2.0,
            y + (h - ph) / 2.0,
            pw,
            ph,
        ));
        true
    }
}

/// The SVG part of picture `n`, as a blip extension.
fn svg_ext(n: usize) -> String {
    format!(
        "<a:extLst><a:ext uri=\"{{96DAC541-7B7A-43D3-8B79-37D633B846F1}}\">\
         <asvg:svgBlip xmlns:asvg=\"http://schemas.microsoft.com/office/drawing/2016/SVG/main\" r:embed=\"{}\"/></a:ext></a:extLst>",
        svg_rid(n)
    )
}

/// `<p:pic>` for picture `n` of the slide.
fn picture_xml(id: u32, n: usize, x: f64, y: f64, w: f64, h: f64) -> String {
    format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"Picture {id}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>\
         <p:blipFill><a:blip r:embed=\"{}\">{}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>\
         <p:spPr>{}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        media_rid(n),
        svg_ext(n),
        xfrm(x, y, w, h)
    )
}

/// Relationship ids inside a slide: rId1 is the layout, rId2 the notes,
/// media from rId10 (an svg picture's SVG part at rId5001+).
fn media_rid(n: usize) -> String {
    format!("rId{}", 9 + n)
}
fn svg_rid(n: usize) -> String {
    format!("rId{}", 5000 + n)
}

pub(crate) fn xfrm(x: f64, y: f64, w: f64, h: f64) -> String {
    format!(
        "<a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>",
        emu(x),
        emu(y),
        emu(w),
        emu(h)
    )
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

const PAD: f64 = 120.0;
const CONTENT_W: f64 = SLIDE_W - 2.0 * PAD;

#[derive(Clone, Copy)]
enum Align {
    Top(f64),
    Center,
    /// The bottom edge of the stack.
    Bottom(f64),
}

/// Where each item of a vertical stack starts, CSS-flex style: `heights`
/// with `gap` between them, aligned in the padded slide. A stack taller
/// than the slide starts at the top (`safe` alignment).
fn stack(heights: &[f64], gap: f64, align: Align) -> Vec<f64> {
    let total: f64 = heights.iter().sum::<f64>() + gap * heights.len().saturating_sub(1) as f64;
    let top = match align {
        Align::Top(top) => top,
        Align::Center => (PAD + (SLIDE_H - 2.0 * PAD - total) / 2.0).max(PAD),
        Align::Bottom(bottom) => (bottom - total).max(PAD),
    };
    let mut y = top;
    heights
        .iter()
        .map(|h| {
            let at = y;
            y += h + gap;
            at
        })
        .collect()
}

/// One stacked text item.
struct Item {
    name: &'static str,
    block: TextBlock,
    x: f64,
    width: f64,
    title: bool,
}

fn item(
    name: &'static str,
    paras: &[Para],
    style: &Style,
    x: f64,
    width: f64,
    theme: &Theme,
) -> Item {
    Item {
        name,
        block: text_block(paras, style, width, theme),
        x,
        width,
        title: false,
    }
}

fn place(canvas: &mut Canvas<'_>, items: &[Item], gap: f64, align: Align) -> Vec<f64> {
    let heights: Vec<f64> = items.iter().map(|i| i.block.height).collect();
    let ys = stack(&heights, gap, align);
    for (it, y) in items.iter().zip(&ys) {
        canvas.text(it.name, it.x, *y, it.width, &it.block, it.title);
    }
    ys
}

fn headline(text: &str, size: f64, max_w: f64, x: f64, theme: &Theme) -> Item {
    let mut it = item(
        "Headline",
        &one(inline_pieces(text)),
        &HEADLINE.size(size),
        x,
        max_w,
        theme,
    );
    it.title = true;
    it
}

fn footnote(canvas: &mut Canvas<'_>, f: &SlideFields) {
    if let Some(note) = present(&f.footnote) {
        let block = text_block(
            &one(inline_pieces(note)),
            &FOOTNOTE,
            CONTENT_W,
            canvas.theme,
        );
        let y = SLIDE_H - 56.0 - block.height;
        canvas.text("Footnote", PAD, y, CONTENT_W, &block, false);
    }
}

fn present(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// A chart's data, when the field holds a spec the app can draw.
fn chart_data(f: &SlideFields) -> Option<ChartData> {
    let spec = slide_charts::parse_spec(f.chart.as_ref()?).ok()?;
    Some(ChartData::from_spec(&spec))
}

fn draw_typed(canvas: &mut Canvas<'_>, layout: Layout, f: &SlideFields) {
    let theme = canvas.theme;
    let kicker = |x: f64, w: f64| {
        present(&f.kicker).map(|k| item("Kicker", &one(inline_pieces(k)), &KICKER, x, w, theme))
    };
    match layout {
        Layout::Title => {
            canvas.rect(PAD, PAD, 120.0, 12.0, &theme.accent, 6.0);
            let mut items: Vec<Item> = kicker(PAD, CONTENT_W).into_iter().collect();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 132.0, 1500.0, PAD, theme));
            }
            if let Some(s) = present(&f.sub) {
                items.push(item(
                    "Subtitle",
                    &one(inline_pieces(s)),
                    &SUB,
                    PAD,
                    1200.0,
                    theme,
                ));
            }
            place(canvas, &items, 40.0, Align::Bottom(SLIDE_H - 160.0));
        }
        Layout::Section => {
            canvas.rect(SLIDE_W - 36.0, 0.0, 36.0, SLIDE_H, &theme.accent, 0.0);
            let mut items: Vec<Item> = present(&f.kicker)
                .map(|k| {
                    item(
                        "Kicker",
                        &one(inline_pieces(k)),
                        &KICKER.size(40.0),
                        PAD,
                        CONTENT_W,
                        theme,
                    )
                })
                .into_iter()
                .collect();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 136.0, 1500.0, PAD, theme));
            }
            place(canvas, &items, 28.0, Align::Bottom(SLIDE_H - 180.0));
        }
        Layout::Statement => {
            let mut items = Vec::new();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 120.0, 1600.0, PAD, theme));
            }
            if let Some(s) = present(&f.sub) {
                items.push(item(
                    "Subtitle",
                    &one(inline_pieces(s)),
                    &SUB,
                    PAD,
                    1280.0,
                    theme,
                ));
            }
            place(canvas, &items, 36.0, Align::Center);
        }
        Layout::Bullets => {
            let mut items: Vec<Item> = kicker(PAD, CONTENT_W).into_iter().collect();
            if let Some(h) = present(&f.headline) {
                let mut it = headline(h, 80.0, CONTENT_W, PAD, theme);
                // The theme's 24 px bottom margin.
                it.block.height += 24.0;
                items.push(it);
            }
            if let Some(list) = f.bullets.as_deref().filter(|l| !l.is_empty()) {
                items.push(item("Bullets", &bullets(list), &BULLET, PAD, 1500.0, theme));
            }
            place(canvas, &items, 32.0, Align::Top(140.0));
        }
        Layout::StatRow => {
            let mut items: Vec<Item> = kicker(PAD, CONTENT_W).into_iter().collect();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 80.0, CONTENT_W, PAD, theme));
            }
            let stats = f.stats.as_deref().unwrap_or_default();
            let n = stats.len().max(1) as f64;
            let col_w = (CONTENT_W - 96.0 * (n - 1.0)) / n;
            let cells: Vec<(TextBlock, TextBlock)> = stats
                .iter()
                .map(|s| {
                    (
                        text_block(&one(inline_pieces(&s.value)), &STAT_VALUE, col_w, theme),
                        text_block(
                            &one(inline_pieces(&s.label)),
                            &STAT_LABEL,
                            col_w.min(460.0),
                            theme,
                        ),
                    )
                })
                .collect();
            let row_h = cells
                .iter()
                .map(|(v, l)| v.height + 12.0 + l.height)
                .fold(0.0, f64::max);
            let mut heights: Vec<f64> = items.iter().map(|i| i.block.height).collect();
            heights.push(row_h);
            let ys = stack(&heights, 48.0, Align::Center);
            for (it, y) in items.iter().zip(&ys) {
                canvas.text(it.name, it.x, *y, it.width, &it.block, it.title);
            }
            let row_y = ys.last().copied().unwrap_or(PAD);
            for (i, (value, label)) in cells.iter().enumerate() {
                let x = PAD + i as f64 * (col_w + 96.0);
                canvas.text("Stat", x, row_y, col_w, value, false);
                canvas.text(
                    "Stat label",
                    x,
                    row_y + value.height + 12.0,
                    col_w.min(460.0),
                    label,
                    false,
                );
            }
        }
        Layout::TwoCol => {
            let mut items: Vec<Item> = kicker(PAD, CONTENT_W).into_iter().collect();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 80.0, CONTENT_W, PAD, theme));
            }
            let col_w = (CONTENT_W - 64.0) / 2.0;
            let inner_w = col_w - 96.0;
            let cols: Vec<Vec<TextBlock>> = f
                .columns
                .iter()
                .flatten()
                .take(2)
                .map(|c| {
                    let mut blocks = vec![text_block(
                        &one(inline_pieces(&c.kicker)),
                        &KICKER,
                        inner_w,
                        theme,
                    )];
                    if let Some(body) = c.body.as_deref().filter(|b| !b.trim().is_empty()) {
                        blocks.push(text_block(&one(inline_pieces(body)), &BODY, inner_w, theme));
                    }
                    if let Some(list) = c.bullets.as_deref().filter(|l| !l.is_empty()) {
                        blocks.push(text_block(&bullets(list), &BULLET, inner_w, theme));
                    }
                    blocks
                })
                .collect();
            let inner_h = |blocks: &[TextBlock]| {
                blocks.iter().map(|b| b.height).sum::<f64>()
                    + 28.0 * blocks.len().saturating_sub(1) as f64
            };
            let card_h = cols.iter().map(|b| inner_h(b)).fold(0.0, f64::max) + 88.0;
            let mut heights: Vec<f64> = items.iter().map(|i| i.block.height).collect();
            heights.push(card_h);
            let ys = stack(&heights, 40.0, Align::Center);
            for (it, y) in items.iter().zip(&ys) {
                canvas.text(it.name, it.x, *y, it.width, &it.block, it.title);
            }
            let card_y = ys.last().copied().unwrap_or(PAD);
            for (i, blocks) in cols.iter().enumerate() {
                let x = PAD + i as f64 * (col_w + 64.0);
                canvas.rect(x, card_y, col_w, card_h, &theme.surface, 24.0);
                let mut y = card_y + 44.0;
                for (j, block) in blocks.iter().enumerate() {
                    let name = if j == 0 {
                        "Column kicker"
                    } else {
                        "Column text"
                    };
                    canvas.text(name, x + 48.0, y, inner_w, block, false);
                    y += block.height + 28.0;
                }
            }
        }
        Layout::Quote => {
            let mark = text_block(
                &one(plain("\u{201C}")),
                &Style {
                    alpha: Some(90),
                    ..Style::new(Font::Display, 360.0, 1.0, Color::Accent)
                },
                300.0,
                theme,
            );
            canvas.text("Quote mark", 100.0, 90.0, 300.0, &mark, false);
            let x = 200.0;
            let w = (SLIDE_W - x - PAD).min(1500.0);
            let mut items = Vec::new();
            if let Some(q) = present(&f.quote) {
                let mut it = item("Quote", &one(inline_pieces(q)), &QUOTE, x, w, theme);
                it.title = true;
                items.push(it);
            }
            if let Some(c) = present(&f.cite) {
                let mut pieces = vec![Piece::Text(
                    "\u{2014}\u{a0}".to_string(),
                    Inline {
                        accent: true,
                        ..Inline::default()
                    },
                )];
                pieces.extend(inline_pieces(c));
                items.push(item("Citation", &one(pieces), &CITE, x, w, theme));
            }
            place(canvas, &items, 48.0, Align::Center);
        }
        Layout::ImageLeft => {
            let x = 1036.0;
            let w = SLIDE_W - x - PAD;
            let mut items = Vec::new();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 80.0, w, x, theme));
            }
            if let Some(b) = present(&f.body) {
                items.push(item("Body", &one(inline_pieces(b)), &BODY, x, w, theme));
            }
            if let Some(list) = f.bullets.as_deref().filter(|l| !l.is_empty()) {
                items.push(item("Bullets", &bullets(list), &BULLET, x, w, theme));
            }
            place(canvas, &items, 28.0, Align::Center);
            let (bw, bh) = (820.0, 600.0);
            if let Some(data) = chart_data(f) {
                let y = (SLIDE_H - bh) / 2.0;
                canvas.rect(PAD, y, bw, bh, &theme.surface, 24.0);
                canvas.chart(data, PAD + 24.0, y + 24.0, bw - 48.0, bh - 48.0);
            } else if let Some(svg) = present(&f.svg) {
                let bh = 840.0;
                canvas.picture(svg, PAD, (SLIDE_H - bh) / 2.0, bw, bh);
            }
        }
        Layout::Chart => {
            let mut items: Vec<Item> = kicker(PAD, CONTENT_W).into_iter().collect();
            if let Some(h) = present(&f.headline) {
                items.push(headline(h, 80.0, CONTENT_W, PAD, theme));
            }
            let chart_h = 640.0;
            let mut heights: Vec<f64> = items.iter().map(|i| i.block.height).collect();
            heights.push(chart_h);
            let ys = stack(&heights, 40.0, Align::Center);
            for (it, y) in items.iter().zip(&ys) {
                canvas.text(it.name, it.x, *y, it.width, &it.block, it.title);
            }
            let y = ys.last().copied().unwrap_or(PAD);
            if let Some(data) = chart_data(f) {
                canvas.chart(data, PAD, y, CONTENT_W, chart_h);
            } else if let Some(svg) = present(&f.svg) {
                canvas.picture(svg, PAD, y, CONTENT_W, chart_h);
            }
        }
        Layout::Custom => {}
    }
    footnote(canvas, f);
}

/// A free-form slide's text as paragraphs: its first `<h1>`..`<h3>` as the
/// heading, every other block (`p`, `div`, `li`, …) its own paragraph and list
/// items bullets. Pictures, styles and scripts are left out.
fn block_text(html: &str) -> (Option<String>, Vec<Para>) {
    const BLOCKS: &[&str] = &[
        "p",
        "div",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "figcaption",
        "section",
        "header",
        "footer",
        "tr",
        "ul",
        "ol",
        "table",
        "figure",
    ];
    const SKIPPED: &[&str] = &["svg", "style", "script", "template"];
    let mut heading: Option<String> = None;
    let mut paras: Vec<Para> = Vec::new();
    let mut text = String::new();
    // Whether the block being read is a heading, or a list item.
    let mut in_heading = false;
    let mut bullet = false;
    let mut skip_depth = 0usize;
    let mut at = 0;
    let flush = |text: &mut String,
                 in_heading: bool,
                 bullet: bool,
                 heading: &mut Option<String>,
                 paras: &mut Vec<Para>| {
        let t = decode_entities(text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        text.clear();
        if t.is_empty() {
            return;
        }
        if in_heading && heading.is_none() {
            *heading = Some(t);
        } else {
            paras.push(Para {
                pieces: plain(&t),
                bullet,
            });
        }
    };
    for tok in slide_html::scan(html) {
        if skip_depth == 0 {
            text.push_str(&html[at..tok.range.start]);
        }
        at = tok.range.end;
        match &tok.kind {
            TokKind::Open { name, self_closing } => {
                if SKIPPED.contains(&name.as_str()) && !self_closing {
                    skip_depth += 1;
                } else if skip_depth > 0 {
                } else if name == "br" {
                    flush(&mut text, in_heading, bullet, &mut heading, &mut paras);
                } else if BLOCKS.contains(&name.as_str()) {
                    flush(&mut text, in_heading, bullet, &mut heading, &mut paras);
                    in_heading = matches!(name.as_str(), "h1" | "h2" | "h3");
                    bullet = name == "li";
                } else if matches!(name.as_str(), "td" | "th") {
                    text.push_str("  ");
                }
            }
            TokKind::Close { name } => {
                if SKIPPED.contains(&name.as_str()) {
                    skip_depth = skip_depth.saturating_sub(1);
                } else if skip_depth == 0 && BLOCKS.contains(&name.as_str()) {
                    flush(&mut text, in_heading, bullet, &mut heading, &mut paras);
                    in_heading = false;
                    bullet = false;
                }
            }
            TokKind::Comment => {}
        }
    }
    if skip_depth == 0 {
        text.push_str(&html[at..]);
    }
    flush(&mut text, in_heading, bullet, &mut heading, &mut paras);
    (heading, paras)
}

/// The first `<svg>…</svg>` in `html`.
fn first_svg(html: &str) -> Option<&str> {
    let start = html.find("<svg")?;
    let end = html[start..].find("</svg>")? + start + 6;
    Some(&html[start..end])
}

/// A slide with no fields to read: its heading as the title, its other
/// blocks as paragraphs (list items as bullets), and its first picture
/// beside them.
fn draw_fallback(canvas: &mut Canvas<'_>, html: &str) {
    let theme = canvas.theme;
    let (heading, paras) = block_text(html);
    let svg = first_svg(html);
    let text_w = if svg.is_some() { 900.0 } else { CONTENT_W };
    let mut items = Vec::new();
    if let Some(h) = &heading {
        items.push(headline(h, 80.0, text_w, PAD, theme));
    }
    if !paras.is_empty() {
        let style = if paras.iter().any(|p| p.bullet) {
            BULLET.size(40.0)
        } else {
            BODY
        };
        items.push(item("Text", &paras, &style, PAD, text_w, theme));
    }
    place(canvas, &items, 40.0, Align::Center);
    if let Some(svg) = svg {
        let x = PAD + 900.0 + 64.0;
        canvas.picture(svg, x, PAD, SLIDE_W - PAD - x, SLIDE_H - 2.0 * PAD);
    }
}

fn slide_xml(canvas: &Canvas<'_>) -> String {
    format!(
        "{XML_DECL}<p:sld xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld>{}<p:spTree>{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        canvas.bg.as_deref().unwrap_or(""),
        parts::group_props(),
        canvas.shapes
    )
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Package {
    files: Vec<(String, Vec<u8>)>,
    slides: usize,
    charts: usize,
    pictures: usize,
}

const CT_SLIDE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_NOTES: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const CT_CHART: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

fn rels(items: &[(String, String, String)]) -> String {
    let mut x = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
    );
    for (id, kind, target) in items {
        x.push_str(&format!(
            "<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{}\"/>",
            esc(target)
        ));
    }
    x.push_str("</Relationships>");
    x
}

impl Package {
    fn put(&mut self, path: impl Into<String>, body: impl Into<Vec<u8>>) {
        self.files.push((path.into(), body.into()));
    }

    fn add_slide(
        &mut self,
        n: usize,
        slide: &DeckSlide,
        theme: &Theme,
        scene: Option<&SlideScene>,
    ) -> Result<(), String> {
        let mut canvas = Canvas::new(theme);
        let typed = Layout::parse(&slide.layout)
            .filter(|l| *l != Layout::Custom)
            .and_then(|l| slide_layouts::reconstruct(&slide.layout, &slide.html).map(|f| (l, f)));
        match (scene, typed) {
            (Some(scene), _) => crate::deck_pptx_scene::draw(&mut canvas, scene, &slide.html),
            (None, Some((layout, fields))) => draw_typed(&mut canvas, layout, &fields),
            (None, None) => draw_fallback(&mut canvas, &slide.html),
        }
        self.slides = n;

        let mut slide_rels = vec![(
            "rId1".to_string(),
            format!("{REL}/slideLayout"),
            "../slideLayouts/slideLayout1.xml".to_string(),
        )];
        let notes = slide.notes.trim();
        if !notes.is_empty() {
            slide_rels.push((
                "rId2".to_string(),
                format!("{REL}/notesSlide"),
                format!("../notesSlides/notesSlide{n}.xml"),
            ));
            self.put(
                format!("ppt/notesSlides/notesSlide{n}.xml"),
                parts::notes_slide_xml(notes),
            );
            self.put(
                format!("ppt/notesSlides/_rels/notesSlide{n}.xml.rels"),
                rels(&[
                    (
                        "rId1".into(),
                        format!("{REL}/notesMaster"),
                        "../notesMasters/notesMaster1.xml".into(),
                    ),
                    (
                        "rId2".into(),
                        format!("{REL}/slide"),
                        format!("../slides/slide{n}.xml"),
                    ),
                ]),
            );
        }
        let xml = slide_xml(&canvas);
        for (i, media) in canvas.media.into_iter().enumerate() {
            match media {
                Media::Chart(data) => {
                    self.charts += 1;
                    let c = self.charts;
                    self.put(
                        format!("ppt/charts/chart{c}.xml"),
                        parts::chart_xml(&data, theme),
                    );
                    self.put(
                        format!("ppt/embeddings/Microsoft_Excel_Worksheet{c}.xlsx"),
                        data.workbook()?,
                    );
                    self.put(
                        format!("ppt/charts/_rels/chart{c}.xml.rels"),
                        rels(&[(
                            "rId1".into(),
                            format!("{REL}/package"),
                            format!("../embeddings/Microsoft_Excel_Worksheet{c}.xlsx"),
                        )]),
                    );
                    slide_rels.push((
                        media_rid(i + 1),
                        format!("{REL}/chart"),
                        format!("../charts/chart{c}.xml"),
                    ));
                }
                Media::Picture { svg, png } => {
                    self.pictures += 1;
                    let p = self.pictures;
                    self.put(format!("ppt/media/image{p}.png"), png);
                    self.put(format!("ppt/media/image{p}.svg"), svg.into_bytes());
                    slide_rels.push((
                        media_rid(i + 1),
                        format!("{REL}/image"),
                        format!("../media/image{p}.png"),
                    ));
                    slide_rels.push((
                        svg_rid(i + 1),
                        format!("{REL}/image"),
                        format!("../media/image{p}.svg"),
                    ));
                }
            }
        }
        self.put(format!("ppt/slides/slide{n}.xml"), xml);
        self.put(
            format!("ppt/slides/_rels/slide{n}.xml.rels"),
            rels(&slide_rels),
        );
        Ok(())
    }

    fn finish(mut self, title: &str, theme: &Theme, now: &str) -> zip::result::ZipResult<Vec<u8>> {
        let notes: Vec<usize> = (1..=self.slides)
            .filter(|n| {
                self.files
                    .iter()
                    .any(|(p, _)| *p == format!("ppt/notesSlides/notesSlide{n}.xml"))
            })
            .collect();

        let mut overrides = String::new();
        let mut ov = |part: &str, ct: &str| {
            overrides.push_str(&format!(
                "<Override PartName=\"/{part}\" ContentType=\"{ct}\"/>"
            ));
        };
        let pml = "application/vnd.openxmlformats-officedocument.presentationml";
        ov(
            "ppt/presentation.xml",
            &format!("{pml}.presentation.main+xml"),
        );
        ov(
            "ppt/slideMasters/slideMaster1.xml",
            &format!("{pml}.slideMaster+xml"),
        );
        ov(
            "ppt/slideLayouts/slideLayout1.xml",
            &format!("{pml}.slideLayout+xml"),
        );
        ov(
            "ppt/notesMasters/notesMaster1.xml",
            &format!("{pml}.notesMaster+xml"),
        );
        ov(
            "ppt/theme/theme1.xml",
            "application/vnd.openxmlformats-officedocument.theme+xml",
        );
        ov(
            "ppt/theme/theme2.xml",
            "application/vnd.openxmlformats-officedocument.theme+xml",
        );
        ov("ppt/presProps.xml", &format!("{pml}.presProps+xml"));
        ov("ppt/viewProps.xml", &format!("{pml}.viewProps+xml"));
        ov("ppt/tableStyles.xml", &format!("{pml}.tableStyles+xml"));
        ov(
            "docProps/core.xml",
            "application/vnd.openxmlformats-package.core-properties+xml",
        );
        for n in 1..=self.slides {
            ov(&format!("ppt/slides/slide{n}.xml"), CT_SLIDE);
        }
        for n in &notes {
            ov(&format!("ppt/notesSlides/notesSlide{n}.xml"), CT_NOTES);
        }
        for c in 1..=self.charts {
            ov(&format!("ppt/charts/chart{c}.xml"), CT_CHART);
        }
        let content_types = format!(
            "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
             <Default Extension=\"png\" ContentType=\"image/png\"/>\
             <Default Extension=\"svg\" ContentType=\"image/svg+xml\"/>\
             <Default Extension=\"xlsx\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"/>\
             {overrides}</Types>"
        );

        let mut pres_rels = vec![
            (
                "rId1".to_string(),
                format!("{REL}/slideMaster"),
                "slideMasters/slideMaster1.xml".to_string(),
            ),
            (
                "rId2".to_string(),
                format!("{REL}/notesMaster"),
                "notesMasters/notesMaster1.xml".to_string(),
            ),
            (
                "rId3".to_string(),
                format!("{REL}/theme"),
                "theme/theme1.xml".to_string(),
            ),
            (
                "rId4".to_string(),
                format!("{REL}/presProps"),
                "presProps.xml".to_string(),
            ),
            (
                "rId5".to_string(),
                format!("{REL}/viewProps"),
                "viewProps.xml".to_string(),
            ),
            (
                "rId6".to_string(),
                format!("{REL}/tableStyles"),
                "tableStyles.xml".to_string(),
            ),
        ];
        let mut slide_ids = String::new();
        for n in 1..=self.slides {
            let rid = format!("rId{}", 9 + n);
            slide_ids.push_str(&format!("<p:sldId id=\"{}\" r:id=\"{rid}\"/>", 255 + n));
            pres_rels.push((rid, format!("{REL}/slide"), format!("slides/slide{n}.xml")));
        }
        let presentation = format!(
            "{XML_DECL}<p:presentation xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\" saveSubsetFonts=\"1\">\
             <p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
             <p:notesMasterIdLst><p:notesMasterId r:id=\"rId2\"/></p:notesMasterIdLst>\
             <p:sldIdLst>{slide_ids}</p:sldIdLst>\
             <p:sldSz cx=\"{}\" cy=\"{}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>",
            emu(SLIDE_W),
            emu(SLIDE_H)
        );
        let core = format!(
            "{XML_DECL}<cp:coreProperties \
             xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
             xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
             xmlns:dcterms=\"http://purl.org/dc/terms/\" \
             xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\
             <dc:title>{}</dc:title>\
             <dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created>\
             <dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified>\
             </cp:coreProperties>",
            esc(title.trim())
        );

        let fixed: Vec<(String, String)> = vec![
            ("[Content_Types].xml".into(), content_types),
            (
                "_rels/.rels".into(),
                rels(&[
                    ("rId1".into(), format!("{REL}/officeDocument"), "ppt/presentation.xml".into()),
                    (
                        "rId2".into(),
                        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties".into(),
                        "docProps/core.xml".into(),
                    ),
                ]),
            ),
            ("docProps/core.xml".into(), core),
            ("ppt/presentation.xml".into(), presentation),
            ("ppt/_rels/presentation.xml.rels".into(), rels(&pres_rels)),
            ("ppt/theme/theme1.xml".into(), parts::theme_xml(theme, "Deck")),
            ("ppt/theme/theme2.xml".into(), parts::theme_xml(theme, "Notes")),
            ("ppt/slideMasters/slideMaster1.xml".into(), parts::master_xml(theme)),
            (
                "ppt/slideMasters/_rels/slideMaster1.xml.rels".into(),
                rels(&[
                    ("rId1".into(), format!("{REL}/slideLayout"), "../slideLayouts/slideLayout1.xml".into()),
                    ("rId2".into(), format!("{REL}/theme"), "../theme/theme1.xml".into()),
                ]),
            ),
            ("ppt/slideLayouts/slideLayout1.xml".into(), parts::layout_xml()),
            (
                "ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(),
                rels(&[("rId1".into(), format!("{REL}/slideMaster"), "../slideMasters/slideMaster1.xml".into())]),
            ),
            ("ppt/notesMasters/notesMaster1.xml".into(), parts::notes_master_xml()),
            (
                "ppt/notesMasters/_rels/notesMaster1.xml.rels".into(),
                rels(&[("rId1".into(), format!("{REL}/theme"), "../theme/theme2.xml".into())]),
            ),
            (
                "ppt/presProps.xml".into(),
                format!("{XML_DECL}<p:presentationPr xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\"/>"),
            ),
            (
                "ppt/viewProps.xml".into(),
                format!(
                    "{XML_DECL}<p:viewPr xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
                     <p:normalViewPr><p:restoredLeft sz=\"15620\"/><p:restoredTop sz=\"94660\"/></p:normalViewPr>\
                     <p:gridSpacing cx=\"76200\" cy=\"76200\"/></p:viewPr>"
                ),
            ),
            (
                "ppt/tableStyles.xml".into(),
                format!("{XML_DECL}<a:tblStyleLst xmlns:a=\"{NS_A}\" def=\"{{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}}\"/>"),
            ),
        ];

        let mut out = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in fixed {
                zip.start_file(name, options)?;
                zip.write_all(body.as_bytes())?;
            }
            for (name, body) in std::mem::take(&mut self.files) {
                zip.start_file(name, options)?;
                zip.write_all(&body)?;
            }
            zip.finish()?;
        }
        Ok(out.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;
    use crate::slide_layouts::Column;

    fn slide(layout: Layout, f: SlideFields, notes: &str) -> DeckSlide {
        let f = slide_layouts::validate(layout, &f).expect("valid fields");
        DeckSlide {
            id: "s".into(),
            position: 0,
            layout: layout_name(layout).into(),
            html: slide_layouts::render(layout, &f).expect("renders"),
            notes: notes.into(),
            slots: Vec::new(),
        }
    }

    fn layout_name(layout: Layout) -> &'static str {
        slide_layouts::LAYOUT_NAMES
            .iter()
            .find(|n| Layout::parse(n) == Some(layout))
            .unwrap()
    }

    fn deck(slides: Vec<DeckSlide>) -> DeckDetail {
        serde_json::from_value(serde_json::json!({
            "id": "d", "title": "Q3 & beyond", "themeName": "paper",
            "themeCss": ".deck, .slide { --bg: #f7f4ec; --ink: #1b1c2b; --ink-2: #4a4b5c; --accent: #4b4ded; --surface: #ffffff; --font-display: Georgia, serif; --font-body: \"Segoe UI\", system-ui, sans-serif; --font-mono: ui-monospace, monospace; }",
            "stage": "slides", "storyline": [], "slides": slides,
            "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z", "assumptions": ""
        }))
        .expect("deck json")
    }

    fn files(bytes: &[u8]) -> std::collections::HashMap<String, String> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..zip.len())
            .map(|i| {
                let mut f = zip.by_index(i).unwrap();
                let name = f.name().unwrap().to_string();
                let mut buf = Vec::new();
                f.read_to_end(&mut buf).unwrap();
                (name, String::from_utf8_lossy(&buf).into_owned())
            })
            .collect()
    }

    /// A relationship target as an archive path.
    fn resolve(dir: &str, target: &str) -> String {
        let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
        for piece in target.split('/') {
            match piece {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                p => parts.push(p),
            }
        }
        parts.join("/")
    }

    fn fields(v: serde_json::Value) -> SlideFields {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn inline_html_becomes_styled_runs() {
        let pieces = inline_pieces(
            "Grow <strong>12%</strong> &amp; <span class=\"accent\">fast</span><br>now",
        );
        assert_eq!(
            pieces,
            vec![
                Piece::Text("Grow ".into(), Inline::default()),
                Piece::Text(
                    "12%".into(),
                    Inline {
                        bold: true,
                        ..Inline::default()
                    }
                ),
                Piece::Text(" & ".into(), Inline::default()),
                Piece::Text(
                    "fast".into(),
                    Inline {
                        accent: true,
                        ..Inline::default()
                    }
                ),
                Piece::Break,
                Piece::Text("now".into(), Inline::default()),
            ]
        );
    }

    #[test]
    fn every_part_is_well_formed_and_referenced() {
        let slides = vec![
            slide(Layout::Title, fields(serde_json::json!({"kicker": "Review", "headline": "Q3 <em>wins</em>", "sub": "Ferry Labs"})), "Open with the number."),
            slide(Layout::Bullets, fields(serde_json::json!({"headline": "What went well", "bullets": ["Revenue up 12%", "Churn down", "Tickets halved"]})), ""),
            slide(Layout::StatRow, fields(serde_json::json!({"headline": "By the numbers", "stats": [{"value": "12%", "label": "revenue growth"}, {"value": "3x", "label": "faster onboarding"}]})), ""),
            slide(Layout::TwoCol, SlideFields {
                headline: Some("Before and after".into()),
                columns: Some(vec![
                    Column { kicker: "Before".into(), body: Some("Manual reports every week".into()), bullets: None },
                    Column { kicker: "After".into(), body: None, bullets: Some(vec!["Automatic".into(), "Daily".into()]) },
                ]),
                ..SlideFields::default()
            }, ""),
            slide(Layout::Quote, fields(serde_json::json!({"quote": "It just works.", "cite": "A customer"})), ""),
            slide(Layout::Chart, fields(serde_json::json!({"headline": "Revenue by quarter", "chart": {"type": "bar", "categories": ["Q1", "Q2", "Q3"], "series": [{"name": "2026", "values": [10, 12, 15]}], "unit_prefix": "$"}})), "Point at Q3."),
            slide(Layout::Section, fields(serde_json::json!({"kicker": "Part 2", "headline": "Next year"})), ""),
            DeckSlide {
                id: "c".into(), position: 7, layout: "custom".into(),
                html: "<h2>Our 日本 plan</h2><p>Hire two engineers.</p><svg viewBox=\"0 0 100 50\"><rect width=\"100\" height=\"50\" style=\"fill:var(--accent)\"/></svg>".into(),
                notes: String::new(), slots: Vec::new(),
            },
        ];
        let bytes = build(&deck(slides), None).unwrap();
        let files = files(&bytes);

        // Every XML part parses.
        for (name, body) in &files {
            if name.ends_with(".xml") || name.ends_with(".rels") || name.ends_with(".svg") {
                let mut reader = quick_xml::Reader::from_str(body);
                loop {
                    match reader.read_event() {
                        Ok(quick_xml::events::Event::Eof) => break,
                        Err(e) => panic!("{name} is not well-formed: {e}"),
                        _ => {}
                    }
                }
            }
        }
        // Every relationship target exists, and every part but the content
        // types and the root rels has a content type.
        let types = &files["[Content_Types].xml"];
        for (name, body) in &files {
            if !name.ends_with(".rels") {
                continue;
            }
            let dir = name
                .trim_end_matches(".rels")
                .rsplit_once("/_rels/")
                .map(|(d, _)| d)
                .unwrap_or("");
            for target in body
                .split("Target=\"")
                .skip(1)
                .map(|s| &s[..s.find('"').unwrap()])
            {
                let path = resolve(dir, target);
                assert!(files.contains_key(&path), "{name} points at missing {path}");
                let ext = path.rsplit('.').next().unwrap();
                assert!(
                    types.contains(&format!("PartName=\"/{path}\""))
                        || types.contains(&format!("Extension=\"{ext}\"")),
                    "{path} has no content type"
                );
            }
        }
        assert_eq!(
            files
                .keys()
                .filter(|k| k.starts_with("ppt/slides/slide"))
                .count(),
            8
        );
        assert_eq!(
            files
                .keys()
                .filter(|k| k.starts_with("ppt/notesSlides/notesSlide"))
                .count(),
            2
        );
        assert!(files.contains_key("ppt/charts/chart1.xml"));
        assert!(files.contains_key("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"));
        assert!(
            files.contains_key("ppt/media/image1.png")
                && files.contains_key("ppt/media/image1.svg")
        );

        // Titles are placeholders; text keeps its formatting.
        let s1 = &files["ppt/slides/slide1.xml"];
        assert!(s1.contains("<p:ph type=\"title\"/>"));
        assert!(s1.contains("i=\"1\"") && s1.contains(">wins</a:t>"));
        assert!(s1.contains("cap=\"all\""), "kicker is caps");
        assert!(files["ppt/slides/slide2.xml"].matches("<a:buChar").count() == 3);
        assert!(files["ppt/notesSlides/notesSlide1.xml"].contains("Open with the number."));
        assert!(files["ppt/charts/chart1.xml"].contains("&quot;$&quot;General"));
        let custom = &files["ppt/slides/slide8.xml"];
        assert!(custom.contains("lang=\"zh-CN\"") || custom.contains("lang=\"ja-JP\""));
        assert!(custom.contains("Hire two engineers."));
        assert!(files["ppt/media/image1.svg"].contains("#4B4DED"));
        assert!(files["docProps/core.xml"].contains("Q3 &amp; beyond"));
    }

    #[test]
    fn an_edited_typed_slide_falls_back_to_its_text() {
        let s = DeckSlide {
            id: "x".into(),
            position: 0,
            layout: "bullets".into(),
            html: "<h2 class=\"headline\">Hand edited</h2><ul><li>One</li></ul>".into(),
            notes: String::new(),
            slots: Vec::new(),
        };
        let files = files(&build(&deck(vec![s]), None).unwrap());
        let xml = &files["ppt/slides/slide1.xml"];
        assert!(xml.contains(">Hand edited</a:t>") && xml.contains("One"));
    }

    #[test]
    fn stacks_align_like_the_theme() {
        assert_eq!(
            stack(&[100.0, 200.0], 40.0, Align::Top(140.0)),
            vec![140.0, 280.0]
        );
        assert_eq!(stack(&[100.0], 0.0, Align::Bottom(920.0)), vec![820.0]);
        assert_eq!(stack(&[240.0], 0.0, Align::Center), vec![420.0]);
        // Too tall: starts at the top padding, never above it.
        assert_eq!(stack(&[2000.0], 0.0, Align::Center), vec![120.0]);
    }
}
