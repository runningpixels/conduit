//! The fixed parts of a deck saved as PowerPoint, and its native charts and
//! picture fallbacks. `deck_pptx` lays out the slides and assembles the
//! package; everything here is a pure function of the theme or the data.

use std::sync::{Arc, OnceLock};

use crate::slide_charts::ChartSpec;

pub const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
pub const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
pub const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
pub const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
pub const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// EMU per canvas pixel: the 1920 px slide is 13.333 in (12 192 000 EMU).
pub const EMU: f64 = 6350.0;
pub const SLIDE_W: f64 = 1920.0;
pub const SLIDE_H: f64 = 1080.0;

pub fn emu(px: f64) -> i64 {
    (px * EMU).round() as i64
}

/// Hundredths of a point for a canvas pixel size (1 px = 0.5 pt).
pub fn hundredths(px: f64) -> i64 {
    (px * 50.0).round() as i64
}

pub fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/// The deck's theme tokens, as PowerPoint can use them.
#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    /// `RRGGBB`.
    pub bg: String,
    pub ink: String,
    pub ink2: String,
    pub accent: String,
    pub surface: String,
    pub font_display: String,
    pub font_body: String,
    pub font_mono: String,
    pub dark: bool,
}

/// Fonts a viewer is very likely to have (Windows and macOS Office both
/// ship them). Anything else in a theme's stack is skipped.
const SAFE_FONTS: &[&str] = &[
    "Aptos",
    "Arial",
    "Calibri",
    "Cambria",
    "Candara",
    "Consolas",
    "Constantia",
    "Corbel",
    "Courier New",
    "Garamond",
    "Georgia",
    "Gill Sans MT",
    "Palatino Linotype",
    "Tahoma",
    "Times New Roman",
    "Trebuchet MS",
    "Verdana",
];

/// The first safe font named in a CSS font stack, else one for its generic
/// family: Georgia for serif stacks, Consolas for monospace, Calibri for the rest.
pub fn safe_font(stack: &str) -> String {
    let names: Vec<String> = stack
        .split(',')
        .map(|n| n.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|n| !n.is_empty())
        .collect();
    for name in &names {
        if let Some(safe) = SAFE_FONTS.iter().find(|s| s.eq_ignore_ascii_case(name)) {
            return (*safe).to_string();
        }
    }
    let lower = stack.to_ascii_lowercase();
    if lower.contains("monospace") || lower.contains("mono") || lower.contains("courier") {
        "Consolas".to_string()
    } else if names.iter().any(|n| n.eq_ignore_ascii_case("serif"))
        || lower.contains("times")
        || lower.contains("palatino")
        || lower.contains("iowan")
    {
        "Georgia".to_string()
    } else {
        "Calibri".to_string()
    }
}

/// The value of the first `--name:` declaration in `css`.
fn css_token<'a>(css: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("--{name}:");
    let start = css.find(&needle)? + needle.len();
    let rest = &css[start..];
    let end = rest.find([';', '}']).unwrap_or(rest.len());
    Some(rest[..end].trim())
}

/// `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb(r, g, b)` as `RRGGBB`.
pub fn css_color(value: &str) -> Option<String> {
    let v = value.trim();
    if let Some(hex) = v.strip_prefix('#') {
        let hex: String = match hex.len() {
            3 | 4 => hex.chars().take(3).flat_map(|c| [c, c]).collect(),
            6 | 8 => hex[..6].to_string(),
            _ => return None,
        };
        return hex
            .chars()
            .all(|c| c.is_ascii_hexdigit())
            .then(|| hex.to_ascii_uppercase());
    }
    let inner = v
        .strip_prefix("rgba(")
        .or_else(|| v.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<u8> = inner
        .split([',', ' ', '/'])
        .filter(|p| !p.trim().is_empty())
        .take(3)
        .map(|p| {
            p.trim()
                .parse::<f64>()
                .ok()
                .map(|n| n.clamp(0.0, 255.0) as u8)
        })
        .collect::<Option<Vec<_>>>()?;
    (parts.len() == 3).then(|| format!("{:02X}{:02X}{:02X}", parts[0], parts[1], parts[2]))
}

fn luminance(hex: &str) -> f64 {
    let c = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0) as f64 / 255.0;
    0.2126 * c(0) + 0.7152 * c(2) + 0.0722 * c(4)
}

impl Theme {
    /// The tokens of a deck's theme stylesheet. Missing or unreadable colours
    /// fall back to the Paper starter's.
    pub fn from_css(css: &str) -> Theme {
        let color = |name: &str, fallback: &str| {
            css_token(css, name)
                .and_then(css_color)
                .unwrap_or_else(|| fallback.to_string())
        };
        let bg = color("bg", "F7F4EC");
        let ink = color("ink", "1B1C2B");
        let dark = luminance(&bg) < luminance(&ink);
        Theme {
            ink2: color("ink-2", if dark { "B8B4AD" } else { "4A4B5C" }),
            accent: color("accent", "4B4DED"),
            surface: color("surface", if dark { "171923" } else { "FFFFFF" }),
            font_display: safe_font(css_token(css, "font-display").unwrap_or("sans-serif")),
            font_body: safe_font(css_token(css, "font-body").unwrap_or("sans-serif")),
            font_mono: safe_font(css_token(css, "font-mono").unwrap_or("monospace")),
            bg,
            ink,
            dark,
        }
    }

    /// The colour a CSS token names, for SVG pictures (`var(--accent)`).
    pub fn token(&self, name: &str) -> Option<&str> {
        Some(match name {
            "bg" => &self.bg,
            "ink" => &self.ink,
            "ink-2" => &self.ink2,
            "accent" => &self.accent,
            "surface" => &self.surface,
            _ => return None,
        })
    }
}

/// The `<a:majorFont>` / `<a:minorFont>` body: a Latin face plus the
/// Japanese, Korean and Chinese faces Office uses for those scripts.
fn font_collection(latin: &str) -> String {
    format!(
        "<a:latin typeface=\"{}\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/>\
         <a:font script=\"Jpan\" typeface=\"Yu Gothic\"/>\
         <a:font script=\"Hang\" typeface=\"Malgun Gothic\"/>\
         <a:font script=\"Hans\" typeface=\"Microsoft YaHei\"/>\
         <a:font script=\"Hant\" typeface=\"Microsoft JhengHei\"/>",
        esc(latin)
    )
}

/// `ppt/theme/theme1.xml`: the deck's colours as the scheme (dk1/lt1 are the
/// darker and lighter of bg and ink) and its fonts as major (display) and
/// minor (body).
pub fn theme_xml(t: &Theme, name: &str) -> String {
    let (dk, lt) = if t.dark {
        (&t.bg, &t.ink)
    } else {
        (&t.ink, &t.bg)
    };
    let srgb = |v: &str| format!("<a:srgbClr val=\"{v}\"/>");
    let fills = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>".repeat(3);
    let lines =
        "<a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>".repeat(3);
    let effects = "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3);
    format!(
        "{XML_DECL}<a:theme xmlns:a=\"{NS_A}\" name=\"{name}\"><a:themeElements>\
         <a:clrScheme name=\"{name}\">\
         <a:dk1>{}</a:dk1><a:lt1>{}</a:lt1><a:dk2>{}</a:dk2><a:lt2>{}</a:lt2>\
         <a:accent1>{}</a:accent1><a:accent2>{}</a:accent2><a:accent3>{}</a:accent3>\
         <a:accent4>{}</a:accent4><a:accent5>{}</a:accent5><a:accent6>{}</a:accent6>\
         <a:hlink>{}</a:hlink><a:folHlink>{}</a:folHlink></a:clrScheme>\
         <a:fontScheme name=\"{name}\"><a:majorFont>{}</a:majorFont><a:minorFont>{}</a:minorFont></a:fontScheme>\
         <a:fmtScheme name=\"{name}\"><a:fillStyleLst>{fills}</a:fillStyleLst><a:lnStyleLst>{lines}</a:lnStyleLst>\
         <a:effectStyleLst>{effects}</a:effectStyleLst><a:bgFillStyleLst>{fills}</a:bgFillStyleLst></a:fmtScheme>\
         </a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>",
        srgb(dk),
        srgb(lt),
        srgb(&t.ink2),
        srgb(&t.surface),
        srgb(&t.accent),
        srgb(&t.ink2),
        srgb(SERIES_EXTRA[0]),
        srgb(SERIES_EXTRA[1]),
        srgb(SERIES_EXTRA[2]),
        srgb(SERIES_EXTRA[3]),
        srgb(&t.accent),
        srgb(&t.ink2),
        font_collection(&t.font_display),
        font_collection(&t.font_body),
    )
}

/// `clrMap`: on a dark deck the background is dk1 and text lt1, so text a
/// user adds in PowerPoint is still readable.
fn clr_map(t: &Theme) -> &'static str {
    if t.dark {
        "bg1=\"dk1\" tx1=\"lt1\" bg2=\"dk2\" tx2=\"lt2\""
    } else {
        "bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\""
    }
}

const CLR_MAP_REST: &str = "accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" \
     accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"";

const GROUP_PROPS: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
     <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

pub fn group_props() -> &'static str {
    GROUP_PROPS
}

fn xfrm(x: f64, y: f64, w: f64, h: f64) -> String {
    format!(
        "<a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>",
        emu(x),
        emu(y),
        emu(w),
        emu(h)
    )
}

/// `ppt/slideMasters/slideMaster1.xml`: the deck background, a title and a
/// body placeholder in the deck's fonts and colours (for slides a user adds).
pub fn master_xml(t: &Theme) -> String {
    format!(
        "{XML_DECL}<p:sldMaster xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{bg}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\
         <p:spTree>{GROUP_PROPS}\
         <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Title Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"title\"/></p:nvPr></p:nvSpPr>\
         <p:spPr>{title_box}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
         <p:txBody><a:bodyPr vert=\"horz\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" anchor=\"b\"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp>\
         <p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Text Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr>\
         <p:spPr>{body_box}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
         <p:txBody><a:bodyPr vert=\"horz\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp>\
         </p:spTree></p:cSld>\
         <p:clrMap {map} {CLR_MAP_REST}/>\
         <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>\
         <p:txStyles>\
         <p:titleStyle><a:lvl1pPr algn=\"l\"><a:lnSpc><a:spcPct val=\"90000\"/></a:lnSpc><a:defRPr sz=\"4000\" b=\"1\"><a:solidFill><a:srgbClr val=\"{ink}\"/></a:solidFill><a:latin typeface=\"+mj-lt\"/><a:ea typeface=\"+mj-ea\"/><a:cs typeface=\"+mj-cs\"/></a:defRPr></a:lvl1pPr></p:titleStyle>\
         <p:bodyStyle>{body_levels}</p:bodyStyle>\
         <p:otherStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val=\"{ink}\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl1pPr></p:otherStyle>\
         </p:txStyles></p:sldMaster>",
        bg = t.bg,
        ink = t.ink,
        map = clr_map(t),
        title_box = xfrm(120.0, 120.0, 1680.0, 200.0),
        body_box = xfrm(120.0, 360.0, 1680.0, 600.0),
        body_levels = (1..=3)
            .map(|lvl| {
                let indent = 56.0 * lvl as f64;
                format!(
                    "<a:lvl{lvl}pPr marL=\"{}\" indent=\"{}\"><a:spcBef><a:spcPts val=\"1400\"/></a:spcBef>\
                     <a:buClr><a:srgbClr val=\"{}\"/></a:buClr><a:buSzPct val=\"70000\"/><a:buFont typeface=\"Arial\"/><a:buChar char=\"&#9632;\"/>\
                     <a:defRPr sz=\"2200\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl{lvl}pPr>",
                    emu(indent),
                    -emu(56.0),
                    t.accent,
                    t.ink
                )
            })
            .collect::<String>(),
    )
}

/// `ppt/slideLayouts/slideLayout1.xml`: "Title Only", which every slide uses.
pub fn layout_xml() -> String {
    format!(
        "{XML_DECL}<p:sldLayout xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\" type=\"titleOnly\" preserve=\"1\">\
         <p:cSld name=\"Title Only\"><p:spTree>{GROUP_PROPS}\
         <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Title 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"title\"/></p:nvPr></p:nvSpPr>\
         <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp>\
         </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    )
}

/// `ppt/notesMasters/notesMaster1.xml`: the slide picture above the notes.
pub fn notes_master_xml() -> String {
    format!(
        "{XML_DECL}<p:notesMaster xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld><p:spTree>{GROUP_PROPS}\
         <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\" idx=\"2\"/></p:nvPr></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"685800\" y=\"1143000\"/><a:ext cx=\"5486400\" cy=\"3086100\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>\
         <p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" sz=\"quarter\" idx=\"3\"/></p:nvPr></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"685800\" y=\"4400550\"/><a:ext cx=\"5486400\" cy=\"3600450\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
         <p:txBody><a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\"/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp>\
         </p:spTree></p:cSld>\
         <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" {CLR_MAP_REST}/>\
         <p:notesStyle><a:lvl1pPr marL=\"0\" algn=\"l\"><a:defRPr sz=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl1pPr></p:notesStyle>\
         </p:notesMaster>"
    )
}

/// `ppt/notesSlides/notesSlideN.xml` with `notes` as the notes text.
pub fn notes_slide_xml(notes: &str) -> String {
    let paras: String = notes
        .lines()
        .map(|line| {
            if line.trim().is_empty() {
                "<a:p><a:endParaRPr lang=\"en-US\" dirty=\"0\"/></a:p>".to_string()
            } else {
                format!(
                    "<a:p><a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>",
                    esc(line)
                )
            }
        })
        .collect();
    format!(
        "{XML_DECL}<p:notes xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld><p:spTree>{GROUP_PROPS}\
         <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>\
         <p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/>\
         <p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp>\
         </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
    )
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/// Series colours after the deck's accent and second ink.
pub const SERIES_EXTRA: [&str; 4] = ["59A14F", "E15759", "B07AA1", "76B7B2"];

/// A chart's data as PowerPoint gets it.
pub struct ChartData {
    /// Horizontal bars in category order (a funnel), else columns or lines.
    pub kind: ChartKind,
    pub categories: Vec<String>,
    pub series: Vec<(String, Vec<f64>)>,
    pub number_format: String,
    pub y_label: Option<String>,
    /// Category indexes to emphasise (single-series bars only).
    pub highlight: Option<Vec<usize>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartKind {
    Column,
    Line,
    Bars,
}

impl ChartData {
    /// The data of a slide chart. A funnel becomes horizontal bars in stage
    /// order: PowerPoint's own funnel type is missing from older versions
    /// and from Google Slides.
    pub fn from_spec(spec: &ChartSpec) -> ChartData {
        let format = |prefix: &Option<String>, suffix: &Option<String>| {
            let quote = |s: &Option<String>| match s.as_deref().map(str::trim) {
                Some(s) if !s.is_empty() => format!("\"{}\"", s.replace('"', "")),
                _ => String::new(),
            };
            format!("{}General{}", quote(prefix), quote(suffix))
        };
        match spec {
            ChartSpec::Bar(xy) | ChartSpec::Line(xy) => ChartData {
                kind: if matches!(spec, ChartSpec::Bar(_)) {
                    ChartKind::Column
                } else {
                    ChartKind::Line
                },
                categories: xy.categories.clone(),
                series: xy
                    .series
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let name = if s.name.trim().is_empty() {
                            format!("Series {}", i + 1)
                        } else {
                            s.name.clone()
                        };
                        (name, s.values.clone())
                    })
                    .collect(),
                number_format: format(&xy.unit_prefix, &xy.unit_suffix),
                y_label: xy.y_label.clone().filter(|l| !l.trim().is_empty()),
                highlight: xy
                    .highlight
                    .as_ref()
                    .map(|h| h.iter().filter_map(|&i| usize::try_from(i).ok()).collect()),
            },
            ChartSpec::Funnel(f) => ChartData {
                kind: ChartKind::Bars,
                categories: f.stages.iter().map(|s| s.label.clone()).collect(),
                series: vec![(String::new(), f.stages.iter().map(|s| s.value).collect())],
                number_format: format(&f.unit_prefix, &f.unit_suffix),
                y_label: None,
                highlight: None,
            },
        }
    }

    /// The workbook PowerPoint's "Edit Data" opens: categories in column A,
    /// one series per column from B, names in row 1.
    pub fn workbook(&self) -> Result<Vec<u8>, String> {
        use serde_json::{json, Value};
        let mut rows: Vec<Value> = Vec::new();
        let mut header = vec![json!({ "value": "" })];
        header.extend(self.series.iter().map(|(name, _)| json!({ "value": name })));
        rows.push(Value::Array(header));
        for (i, cat) in self.categories.iter().enumerate() {
            let mut row = vec![json!({ "value": cat })];
            row.extend(
                self.series
                    .iter()
                    .map(|(_, values)| json!({ "value": values.get(i).copied() })),
            );
            rows.push(Value::Array(row));
        }
        let spec = json!({ "sheets": [{ "name": "Sheet1", "rows": rows }] });
        let workbook = crate::sheets::spec::Workbook::from_value(&spec)?;
        crate::sheets::xlsx::write_xlsx(&workbook)
    }
}

/// Column letter for a 0-based index (A..Z, then AA..).
fn col(i: usize) -> String {
    let mut n = i + 1;
    let mut s = String::new();
    while n > 0 {
        let r = (n - 1) % 26;
        s.insert(0, (b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    s
}

fn solid(color: &str, alpha: Option<u32>) -> String {
    match alpha {
        Some(a) => format!(
            "<a:solidFill><a:srgbClr val=\"{color}\"><a:alpha val=\"{a}\"/></a:srgbClr></a:solidFill>"
        ),
        None => format!("<a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill>"),
    }
}

fn text_props(t: &Theme, size_px: f64, color: &str, rot: Option<i64>) -> String {
    let rot = rot
        .map(|r| format!(" rot=\"{r}\" vert=\"horz\""))
        .unwrap_or_default();
    format!(
        "<c:txPr><a:bodyPr{rot}/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{}\">{}<a:latin typeface=\"{}\"/></a:defRPr></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>",
        hundredths(size_px),
        solid(color, None),
        esc(&t.font_body)
    )
}

/// `ppt/charts/chartN.xml`: a native chart in the deck's colours over the
/// embedded workbook (`rId1`).
pub fn chart_xml(data: &ChartData, t: &Theme) -> String {
    let n = data.categories.len();
    let palette: Vec<&str> = [t.accent.as_str(), t.ink2.as_str()]
        .into_iter()
        .chain(SERIES_EXTRA)
        .collect();
    let mut sers = String::new();
    for (i, (name, values)) in data.series.iter().enumerate() {
        let color = palette[i % palette.len()];
        let c = col(i + 1);
        sers.push_str(&format!(
            "<c:ser><c:idx val=\"{i}\"/><c:order val=\"{i}\"/>\
             <c:tx><c:strRef><c:f>Sheet1!${c}$1</c:f><c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>{}</c:v></c:pt></c:strCache></c:strRef></c:tx>",
            esc(name)
        ));
        match data.kind {
            ChartKind::Line => {
                let dash = if i == 2 {
                    "<a:prstDash val=\"dash\"/>"
                } else {
                    ""
                };
                sers.push_str(&format!(
                    "<c:spPr><a:ln w=\"{}\" cap=\"rnd\">{}{dash}<a:round/></a:ln></c:spPr>\
                     <c:marker><c:symbol val=\"circle\"/><c:size val=\"7\"/><c:spPr>{}<a:ln><a:noFill/></a:ln></c:spPr></c:marker>",
                    emu(5.0),
                    solid(color, None),
                    solid(color, None)
                ));
            }
            ChartKind::Column | ChartKind::Bars => {
                sers.push_str(&format!(
                    "<c:spPr>{}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val=\"0\"/>",
                    solid(color, None)
                ));
                // Emphasis: the highlighted bars keep the accent, the rest
                // are drawn as outlines, as on the slide.
                if let (Some(hl), true) = (&data.highlight, data.series.len() == 1) {
                    for p in (0..n).filter(|p| !hl.contains(p)) {
                        sers.push_str(&format!(
                            "<c:dPt><c:idx val=\"{p}\"/><c:invertIfNegative val=\"0\"/><c:bubble3D val=\"0\"/>\
                             <c:spPr>{}<a:ln w=\"{}\">{}</a:ln></c:spPr></c:dPt>",
                            solid(&t.surface, None),
                            emu(2.0),
                            solid(&t.ink2, None)
                        ));
                    }
                }
            }
        }
        sers.push_str(&format!(
            "<c:cat><c:strRef><c:f>Sheet1!$A$2:$A${}</c:f><c:strCache><c:ptCount val=\"{n}\"/>",
            n + 1
        ));
        for (p, cat) in data.categories.iter().enumerate() {
            sers.push_str(&format!("<c:pt idx=\"{p}\"><c:v>{}</c:v></c:pt>", esc(cat)));
        }
        sers.push_str(&format!(
            "</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!${c}$2:${c}${}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val=\"{n}\"/>",
            n + 1
        ));
        for (p, v) in values.iter().take(n).enumerate() {
            if v.is_finite() {
                sers.push_str(&format!("<c:pt idx=\"{p}\"><c:v>{v}</c:v></c:pt>"));
            }
        }
        sers.push_str("</c:numCache></c:numRef></c:val>");
        if data.kind == ChartKind::Line {
            sers.push_str("<c:smooth val=\"0\"/>");
        }
        sers.push_str("</c:ser>");
    }

    let plot = match data.kind {
        ChartKind::Column | ChartKind::Bars => format!(
            "<c:barChart><c:barDir val=\"{}\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>{sers}\
             <c:gapWidth val=\"60\"/><c:axId val=\"500000001\"/><c:axId val=\"500000002\"/></c:barChart>",
            if data.kind == ChartKind::Bars { "bar" } else { "col" }
        ),
        ChartKind::Line => format!(
            "<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>{sers}\
             <c:marker val=\"1\"/><c:axId val=\"500000001\"/><c:axId val=\"500000002\"/></c:lineChart>"
        ),
    };
    let horizontal = data.kind == ChartKind::Bars;
    // A funnel reads top to bottom: the category axis runs max-to-min.
    let cat_orientation = if horizontal { "maxMin" } else { "minMax" };
    let (cat_pos, val_pos) = if horizontal { ("l", "b") } else { ("b", "l") };
    let axis_line = format!(
        "<c:spPr><a:ln w=\"{}\">{}</a:ln></c:spPr>",
        emu(2.0),
        solid(&t.ink2, Some(40000))
    );
    let grid = format!(
        "<c:majorGridlines><c:spPr><a:ln w=\"{}\">{}</a:ln></c:spPr></c:majorGridlines>",
        emu(2.0),
        solid(&t.ink2, Some(25000))
    );
    let val_title = data
        .y_label
        .as_ref()
        .map(|label| {
            format!(
                "<c:title><c:tx><c:rich><a:bodyPr rot=\"-5400000\" vert=\"horz\"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{sz}\" b=\"0\">{fill}</a:defRPr></a:pPr><a:r><a:rPr lang=\"en-US\" sz=\"{sz}\" b=\"0\">{fill}</a:rPr><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title>",
                esc(label),
                sz = hundredths(28.0),
                fill = solid(&t.ink2, None)
            )
        })
        .unwrap_or_default();
    let legend = if data.series.len() > 1 {
        format!(
            "<c:legend><c:legendPos val=\"b\"/><c:overlay val=\"0\"/>{}</c:legend>",
            text_props(t, 28.0, &t.ink2, None)
        )
    } else {
        String::new()
    };
    format!(
        "{XML_DECL}<c:chartSpace xmlns:c=\"{NS_C}\" xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\">\
         <c:roundedCorners val=\"0\"/><c:chart><c:autoTitleDeleted val=\"1\"/><c:plotArea><c:layout/>{plot}\
         <c:catAx><c:axId val=\"500000001\"/><c:scaling><c:orientation val=\"{cat_orientation}\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"{cat_pos}\"/>\
         <c:numFmt formatCode=\"General\" sourceLinked=\"0\"/><c:majorTickMark val=\"none\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/>{axis_line}{cat_text}\
         <c:crossAx val=\"500000002\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/><c:noMultiLvlLbl val=\"0\"/></c:catAx>\
         <c:valAx><c:axId val=\"500000002\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"{val_pos}\"/>{grid}{val_title}\
         <c:numFmt formatCode=\"{fmt}\" sourceLinked=\"0\"/><c:majorTickMark val=\"none\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/>\
         <c:spPr><a:ln><a:noFill/></a:ln></c:spPr>{val_text}<c:crossAx val=\"500000001\"/><c:crosses val=\"{crosses}\"/><c:crossBetween val=\"between\"/></c:valAx>\
         <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>{legend}<c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart>\
         <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>{root_text}\
         <c:externalData r:id=\"rId1\"><c:autoUpdate val=\"0\"/></c:externalData></c:chartSpace>",
        cat_text = text_props(t, 28.0, &t.ink2, None),
        val_text = text_props(t, 28.0, &t.ink2, None),
        root_text = text_props(t, 28.0, &t.ink2, None),
        fmt = esc(&data.number_format),
        // With the category axis reversed, the value axis would cross at the top.
        crosses = if horizontal { "max" } else { "autoZero" },
    )
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/// `svg` with every `var(--token)` replaced by the theme's colour or font,
/// so the picture stands alone outside the deck's stylesheet.
pub fn standalone_svg(svg: &str, t: &Theme) -> String {
    let mut out = String::with_capacity(svg.len());
    let mut rest = svg;
    while let Some(at) = rest.find("var(--") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 6..];
        let Some(close) = after.find(')') else {
            out.push_str(&rest[at..]);
            rest = "";
            break;
        };
        let inner = &after[..close];
        let (name, fallback) = match inner.split_once(',') {
            Some((n, f)) => (n.trim(), Some(f.trim())),
            None => (inner.trim(), None),
        };
        let value = match name {
            "font-display" => format!("'{}'", t.font_display),
            "font-body" => format!("'{}'", t.font_body),
            "font-mono" => format!("'{}'", t.font_mono),
            other => match t.token(other) {
                Some(hex) => format!("#{hex}"),
                None => fallback.unwrap_or("currentColor").to_string(),
            },
        };
        out.push_str(&value);
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    // A root without a namespace does not render as a standalone file.
    if !out.contains("xmlns=\"http://www.w3.org/2000/svg\"") {
        out = out.replacen("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"", 1);
    }
    out
}

/// The `viewBox` aspect (width / height) of an svg, if it has one.
pub fn svg_aspect(svg: &str) -> Option<f64> {
    let at = svg.find("viewBox=\"")? + 9;
    let end = svg[at..].find('"')? + at;
    let nums: Vec<f64> = svg[at..end]
        .split([' ', ','])
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    match nums.as_slice() {
        [_, _, w, h] if *w > 0.0 && *h > 0.0 => Some(w / h),
        _ => None,
    }
}

fn fonts() -> Arc<resvg::usvg::fontdb::Database> {
    static DB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        Arc::new(db)
    })
    .clone()
}

/// A standalone svg drawn as a PNG `width` pixels wide, for viewers that
/// don't read the SVG.
pub fn svg_to_png(svg: &str, width: u32) -> Result<Vec<u8>, String> {
    use resvg::{tiny_skia, usvg};
    let options = usvg::Options {
        fontdb: fonts(),
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &options)
        .map_err(|e| format!("a picture's SVG is invalid: {e}"))?;
    let size = tree.size();
    let scale = width as f32 / size.width().max(1.0);
    let height = (size.height() * scale).ceil().max(1.0) as u32;
    let mut pixmap =
        tiny_skia::Pixmap::new(width.max(1), height).ok_or("a picture is too large to draw")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap
        .encode_png()
        .map_err(|e| format!("couldn't encode a picture: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_theme_tokens_and_picks_safe_fonts() {
        let css = ".deck, .slide { --bg: #0c0d12; --ink: #f4f1ec; --ink-2: rgba(244, 241, 236, 0.7); --accent: #ff7a59; --surface: #171923;\
                   --font-display: \"Segoe UI Variable Display\", \"Segoe UI\", system-ui, sans-serif;\
                   --font-body: Georgia, serif; --font-mono: ui-monospace, \"Cascadia Code\", monospace; }";
        let t = Theme::from_css(css);
        assert!(t.dark);
        assert_eq!(
            (t.bg.as_str(), t.ink.as_str(), t.accent.as_str()),
            ("0C0D12", "F4F1EC", "FF7A59")
        );
        assert_eq!(t.ink2, "F4F1EC");
        assert_eq!(
            (
                t.font_display.as_str(),
                t.font_body.as_str(),
                t.font_mono.as_str()
            ),
            ("Calibri", "Georgia", "Consolas")
        );
        let paper = Theme::from_css(
            "--bg: #f7f4ec; --ink: #1b1c2b; --font-display: Georgia, \"Iowan Old Style\", serif;",
        );
        assert!(!paper.dark);
        assert_eq!(paper.font_display, "Georgia");
    }

    #[test]
    fn colours_parse_in_every_css_form() {
        assert_eq!(css_color("#abc").as_deref(), Some("AABBCC"));
        assert_eq!(css_color("#AbCdEf80").as_deref(), Some("ABCDEF"));
        assert_eq!(css_color("rgb(255 0 10)").as_deref(), Some("FF000A"));
        assert_eq!(css_color("oklch(0.7 0.1 30)"), None);
    }

    #[test]
    fn svg_tokens_become_theme_values() {
        let t = Theme::from_css("--bg: #fff; --ink: #000; --accent: #4b4ded;");
        let svg = standalone_svg(
            "<svg viewBox=\"0 0 820 600\"><g style=\"font-family:var(--font-body)\"><rect style=\"fill:var(--accent)\"/><text style=\"fill:var(--nope, #123456)\">x</text></g></svg>",
            &t,
        );
        assert!(svg.contains("fill:#4B4DED"), "{svg}");
        assert!(svg.contains("fill:#123456"), "{svg}");
        assert!(svg.contains("font-family:'Calibri'"), "{svg}");
        assert!(
            svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""),
            "{svg}"
        );
        assert_eq!(svg_aspect(&svg), Some(820.0 / 600.0));
        let png = svg_to_png(&svg, 410).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
    }

    #[test]
    fn a_funnel_becomes_ordered_horizontal_bars() {
        let spec = crate::slide_charts::parse_spec(&serde_json::json!({
            "type": "funnel",
            "stages": [{"label": "Visits", "value": 1000}, {"label": "Signups", "value": 120}],
            "unit_suffix": "%"
        }))
        .unwrap();
        let data = ChartData::from_spec(&spec);
        assert_eq!(data.kind, ChartKind::Bars);
        assert_eq!(data.categories, ["Visits", "Signups"]);
        assert_eq!(data.number_format, "General\"%\"");
        let xml = chart_xml(&data, &Theme::from_css(""));
        assert!(xml.contains("<c:barDir val=\"bar\"/>"));
        assert!(xml.contains("<c:orientation val=\"maxMin\"/>"));
        assert!(data.workbook().unwrap().starts_with(b"PK"));
    }

    #[test]
    fn column_letters() {
        assert_eq!(
            (col(0), col(1), col(25), col(26)),
            ("A".into(), "B".into(), "Z".into(), "AA".into())
        );
    }
}
