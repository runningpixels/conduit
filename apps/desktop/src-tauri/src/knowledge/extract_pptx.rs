//! PowerPoint (`.pptx`) text extraction: each slide in presentation order as
//! a `## Slide N: <title>` section holding its text, tables, chart data and
//! speaker notes.
//!
//! The parts are read with `quick-xml` (entities decoded, never a regex), and
//! every part is read through a `Read::take` capped at
//! [`MAX_DOCUMENT_BYTES`], after the archive's central directory has passed
//! the same limits an xlsx does. Pictures, SmartArt and embedded media are
//! not read; a slide with pictures says how many it left out.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use super::extract::{check_zip_limits, ExtractFailure, Extracted, MAX_DOCUMENT_BYTES};

pub const PPTX_MIME: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/// Most entries a pptx archive may hold: a long deck has a slide, a rels file
/// and often a notes slide per slide, plus its media.
const PPTX_MAX_ENTRIES: usize = 10_000;
/// Most slides read. Past it the text says how many were left out.
const PPTX_MAX_SLIDES: usize = 2_000;
/// Most points written per chart series.
const CHART_MAX_POINTS: usize = 60;

type Archive<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

pub fn extract_pptx(bytes: &[u8]) -> Result<Extracted, ExtractFailure> {
    check_zip_limits(bytes, "pptx", PPTX_MAX_ENTRIES)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ExtractFailure::Unreadable(format!("not a valid pptx/zip archive: {e}")))?;

    let presentation = read_part(&mut archive, "ppt/presentation.xml")?.ok_or_else(|| {
        ExtractFailure::Unreadable("pptx archive has no ppt/presentation.xml".to_string())
    })?;
    let rels = relationships(&mut archive, "ppt/presentation.xml")?;
    let slide_ids = slide_order(&presentation)?;

    let mut out = String::new();
    for (index, rid) in slide_ids.iter().enumerate() {
        if index == PPTX_MAX_SLIDES {
            out.push_str(&format!(
                "(truncated: {} more slides not shown)\n",
                slide_ids.len() - PPTX_MAX_SLIDES
            ));
            break;
        }
        let Some(path) = rels.get(rid).map(|r| r.target.clone()) else {
            continue;
        };
        let Some(xml) = read_part(&mut archive, &path)? else {
            continue;
        };
        let slide = parse_shapes(&xml, false)?;
        let slide_rels = relationships(&mut archive, &path)?;

        let mut charts = Vec::new();
        for rid in &slide.chart_ids {
            if let Some(rel) = slide_rels.get(rid) {
                if let Some(chart_xml) = read_part(&mut archive, &rel.target)? {
                    charts.push(chart_text(&chart_xml)?);
                }
            }
        }
        let notes = match slide_rels
            .values()
            .find(|r| r.kind.ends_with("/notesSlide"))
        {
            Some(rel) => match read_part(&mut archive, &rel.target)? {
                Some(notes_xml) => parse_shapes(&notes_xml, true)?.body_text(),
                None => String::new(),
            },
            None => String::new(),
        };
        write_slide(&mut out, index + 1, &slide, &charts, &notes);
    }

    Ok(Extracted {
        text: out,
        mime_type: Some(PPTX_MIME.to_string()),
    })
}

fn write_slide(out: &mut String, number: usize, slide: &Shapes, charts: &[String], notes: &str) {
    let title = slide.title();
    let hidden = if slide.hidden { " (hidden)" } else { "" };
    if title.is_empty() {
        out.push_str(&format!("## Slide {number}{hidden}\n"));
    } else {
        out.push_str(&format!("## Slide {number}: {title}{hidden}\n"));
    }
    for block in &slide.blocks {
        match block {
            Block::Text { title: true, .. } => {}
            Block::Text { paras, .. } => {
                for (level, text) in paras {
                    out.push_str(&"  ".repeat(*level as usize));
                    out.push_str(text);
                    out.push('\n');
                }
            }
            Block::Table(rows) => {
                for row in rows {
                    out.push_str(&row.join(" | "));
                    out.push('\n');
                }
            }
        }
    }
    for chart in charts {
        out.push_str(chart);
    }
    if slide.pictures > 0 {
        let s = if slide.pictures == 1 { "" } else { "s" };
        out.push_str(&format!("({} picture{s} not included)\n", slide.pictures));
    }
    if !notes.trim().is_empty() {
        out.push_str("Notes:\n");
        out.push_str(notes.trim_end());
        out.push('\n');
    }
    out.push('\n');
}

/// A part's bytes as text, or `None` when the archive has no such part.
fn read_part(archive: &mut Archive<'_>, path: &str) -> Result<Option<String>, ExtractFailure> {
    let Ok(mut entry) = archive.by_name(path) else {
        return Ok(None);
    };
    let mut buf = Vec::new();
    (&mut entry)
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| ExtractFailure::Unreadable(format!("{path}: {e}")))?;
    if buf.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(ExtractFailure::TooLarge {
            bytes: buf.len() as u64,
            cap: MAX_DOCUMENT_BYTES,
        });
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

struct Relationship {
    kind: String,
    target: String,
}

/// The relationships of the part at `path`, keyed by id, with each target
/// resolved to an archive path. External targets (hyperlinks) are dropped.
fn relationships(
    archive: &mut Archive<'_>,
    path: &str,
) -> Result<HashMap<String, Relationship>, ExtractFailure> {
    let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
    let rels_path = if dir.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{dir}/_rels/{file}.rels")
    };
    let Some(xml) = read_part(archive, &rels_path)? else {
        return Ok(HashMap::new());
    };
    let mut map = HashMap::new();
    let mut reader = Reader::from_str(&xml);
    loop {
        match reader.read_event() {
            Err(e) => return Err(ExtractFailure::Unreadable(format!("{rels_path}: {e}"))),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e) | Event::Empty(e)) if e.local_name().as_ref() == b"Relationship" => {
                if attr(&e, b"TargetMode").as_deref() == Some("External") {
                    continue;
                }
                if let (Some(id), Some(target)) = (attr(&e, b"Id"), attr(&e, b"Target")) {
                    map.insert(
                        id,
                        Relationship {
                            kind: attr(&e, b"Type").unwrap_or_default(),
                            target: resolve(dir, &target),
                        },
                    );
                }
            }
            _ => {}
        }
    }
    Ok(map)
}

/// `target` relative to `dir` as an archive path: `../notesSlides/n1.xml`
/// from `ppt/slides` is `ppt/notesSlides/n1.xml`; a leading `/` is the root.
fn resolve(dir: &str, target: &str) -> String {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        dir.split('/').filter(|p| !p.is_empty()).collect()
    };
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

/// The relationship ids of the slides, in presentation order (`p:sldIdLst`).
fn slide_order(xml: &str) -> Result<Vec<String>, ExtractFailure> {
    let mut reader = Reader::from_str(xml);
    let mut ids = Vec::new();
    loop {
        match reader.read_event() {
            Err(e) => {
                return Err(ExtractFailure::Unreadable(format!(
                    "ppt/presentation.xml: {e}"
                )))
            }
            Ok(Event::Eof) => break,
            Ok(Event::Start(e) | Event::Empty(e)) if e.local_name().as_ref() == b"sldId" => {
                if let Some(id) = r_id(&e) {
                    ids.push(id);
                }
            }
            _ => {}
        }
    }
    Ok(ids)
}

/// The `r:id` attribute (any prefix bound to the relationships namespace is
/// written `r:` in practice; matched as a qualified name ending in `:id`).
fn r_id(e: &BytesStart<'_>) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        let key = a.key.as_ref();
        (key.ends_with(b":id")).then(|| {
            a.decode_and_unescape_value(e.decoder())
                .map(|v| v.into_owned())
                .unwrap_or_default()
        })
    })
}

/// An unprefixed attribute's value.
fn attr(e: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        (a.key.as_ref() == name).then(|| {
            a.decode_and_unescape_value(e.decoder())
                .map(|v| v.into_owned())
                .unwrap_or_default()
        })
    })
}

enum Block {
    /// One shape's paragraphs as (indent level, text).
    Text {
        title: bool,
        paras: Vec<(u8, String)>,
    },
    Table(Vec<Vec<String>>),
}

#[derive(Default)]
struct Shapes {
    blocks: Vec<Block>,
    chart_ids: Vec<String>,
    pictures: usize,
    hidden: bool,
}

impl Shapes {
    fn title(&self) -> String {
        self.blocks
            .iter()
            .find_map(|b| match b {
                Block::Text { title: true, paras } => Some(
                    paras
                        .iter()
                        .map(|(_, t)| t.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
                _ => None,
            })
            .unwrap_or_default()
    }

    /// Every text block's paragraphs, one per line (for notes).
    fn body_text(&self) -> String {
        let mut out = String::new();
        for block in &self.blocks {
            if let Block::Text { paras, .. } = block {
                for (_, text) in paras {
                    out.push_str(text);
                    out.push('\n');
                }
            }
        }
        out
    }
}

/// Placeholders that carry no content of their own: the slide picture and
/// running header/footer fields on a notes page, and footers on a slide.
fn skipped_placeholder(kind: &str, notes: bool) -> bool {
    matches!(kind, "sldNum" | "dt" | "ftr" | "hdr") || (notes && kind == "sldImg")
}

/// A text shape while its XML is being read.
#[derive(Default)]
struct OpenShape {
    title: bool,
    /// A placeholder with no content of its own ([`skipped_placeholder`]).
    skipped: bool,
    paras: Vec<(u8, String)>,
}

/// A slide's (or notes page's) shapes in document order.
fn parse_shapes(xml: &str, notes: bool) -> Result<Shapes, ExtractFailure> {
    let mut reader = Reader::from_str(xml);
    let mut shapes = Shapes::default();

    // The shape being read.
    let mut shape: Option<OpenShape> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut row: Vec<String> = Vec::new();
    let mut cell: Option<String> = None;
    let mut para: Option<(u8, String)> = None;
    let mut in_text = false;

    loop {
        let event = reader
            .read_event()
            .map_err(|e| ExtractFailure::Unreadable(format!("pptx slide: {e}")))?;
        match event {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"sld" => {
                shapes.hidden = attr(&e, b"show").as_deref() == Some("0");
            }
            Event::Start(e) if e.local_name().as_ref() == b"sp" => {
                shape = Some(OpenShape::default());
            }
            Event::End(e) if e.local_name().as_ref() == b"sp" => {
                if let Some(OpenShape {
                    title,
                    skipped,
                    paras,
                }) = shape.take()
                {
                    if !skipped && !paras.is_empty() {
                        shapes.blocks.push(Block::Text { title, paras });
                    }
                }
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"ph" => {
                if let Some(s) = shape.as_mut() {
                    let kind = attr(&e, b"type").unwrap_or_default();
                    s.title = matches!(kind.as_str(), "title" | "ctrTitle");
                    s.skipped = skipped_placeholder(&kind, notes);
                }
            }
            Event::Start(e) if e.local_name().as_ref() == b"pic" => {
                shapes.pictures += 1;
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"chart" => {
                if let Some(id) = r_id(&e) {
                    shapes.chart_ids.push(id);
                }
            }
            Event::Start(e) if e.local_name().as_ref() == b"tbl" => {
                table = Some(Vec::new());
            }
            Event::End(e) if e.local_name().as_ref() == b"tbl" => {
                if let Some(rows) = table.take() {
                    if rows.iter().any(|r| r.iter().any(|c| !c.is_empty())) {
                        shapes.blocks.push(Block::Table(rows));
                    }
                }
            }
            Event::Start(e) if e.local_name().as_ref() == b"tr" && table.is_some() => {
                row = Vec::new();
            }
            Event::End(e) if e.local_name().as_ref() == b"tr" => {
                if let Some(rows) = table.as_mut() {
                    rows.push(std::mem::take(&mut row));
                }
            }
            Event::Start(e) if e.local_name().as_ref() == b"tc" && table.is_some() => {
                cell = Some(String::new());
            }
            Event::Empty(e) if e.local_name().as_ref() == b"tc" && table.is_some() => {
                row.push(String::new());
            }
            Event::End(e) if e.local_name().as_ref() == b"tc" => {
                if let Some(text) = cell.take() {
                    row.push(text.trim().to_string());
                }
            }
            Event::Start(e) if e.local_name().as_ref() == b"p" => {
                para = Some((0, String::new()));
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"pPr" => {
                if let Some(p) = para.as_mut() {
                    p.0 = attr(&e, b"lvl")
                        .and_then(|l| l.parse::<u8>().ok())
                        .unwrap_or(0)
                        .min(8);
                }
            }
            Event::End(e) if e.local_name().as_ref() == b"p" => {
                if let Some((level, text)) = para.take() {
                    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    if text.is_empty() {
                        continue;
                    }
                    if let Some(c) = cell.as_mut() {
                        if !c.is_empty() {
                            c.push(' ');
                        }
                        c.push_str(&text);
                    } else if let Some(s) = shape.as_mut() {
                        s.paras.push((level, text));
                    }
                }
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"br" => {
                if let Some(p) = para.as_mut() {
                    p.1.push(' ');
                }
            }
            Event::Start(e) if e.local_name().as_ref() == b"t" => in_text = true,
            Event::End(e) if e.local_name().as_ref() == b"t" => in_text = false,
            Event::Text(t) if in_text => {
                if let Some(p) = para.as_mut() {
                    let decoded = t
                        .decode()
                        .map_err(|e| ExtractFailure::Unreadable(format!("pptx text: {e}")))?;
                    p.1.push_str(&decoded);
                }
            }
            Event::GeneralRef(r) if in_text => {
                if let Some(p) = para.as_mut() {
                    p.1.push_str(&resolve_entity(&r)?);
                }
            }
            _ => {}
        }
    }
    Ok(shapes)
}

fn resolve_entity(r: &quick_xml::events::BytesRef<'_>) -> Result<String, ExtractFailure> {
    let unreadable = |e: String| ExtractFailure::Unreadable(format!("pptx entity: {e}"));
    if let Some(ch) = r
        .resolve_char_ref()
        .map_err(|e| unreadable(e.to_string()))?
    {
        return Ok(ch.to_string());
    }
    let name = r.decode().map_err(|e| unreadable(e.to_string()))?;
    quick_xml::escape::resolve_predefined_entity(&name)
        .map(str::to_string)
        .ok_or_else(|| unreadable(format!("unknown entity &{name};")))
}

/// A chart part as text: `Chart: <title>` then one line per series with its
/// category/value pairs (at most [`CHART_MAX_POINTS`]).
fn chart_text(xml: &str) -> Result<String, ExtractFailure> {
    #[derive(Default)]
    struct Series {
        name: String,
        cats: Vec<String>,
        vals: Vec<String>,
    }
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut title = String::new();
    let mut series: Vec<Series> = Vec::new();
    let inside = |stack: &[Vec<u8>], name: &[u8]| stack.iter().any(|n| n.as_slice() == name);

    loop {
        let event = reader
            .read_event()
            .map_err(|e| ExtractFailure::Unreadable(format!("pptx chart: {e}")))?;
        match event {
            Event::Eof => break,
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_vec();
                if name == b"ser" {
                    series.push(Series::default());
                }
                stack.push(name);
            }
            Event::End(_) => {
                stack.pop();
            }
            Event::Text(t) => {
                let text = t
                    .decode()
                    .map_err(|e| ExtractFailure::Unreadable(format!("pptx chart text: {e}")))?
                    .trim()
                    .to_string();
                if text.is_empty() {
                    continue;
                }
                let leaf = stack.last().map(Vec::as_slice);
                if inside(&stack, b"ser") {
                    let Some(s) = series.last_mut() else { continue };
                    if leaf != Some(b"v") {
                        continue;
                    }
                    if inside(&stack, b"tx") {
                        s.name = text;
                    } else if inside(&stack, b"cat") || inside(&stack, b"xVal") {
                        s.cats.push(text);
                    } else if inside(&stack, b"val") || inside(&stack, b"yVal") {
                        s.vals.push(text);
                    }
                } else if inside(&stack, b"title")
                    // Axis titles sit inside the plot area; only the chart's own.
                    && !inside(&stack, b"plotArea")
                    && matches!(leaf, Some(b"t") | Some(b"v"))
                {
                    if !title.is_empty() {
                        title.push(' ');
                    }
                    title.push_str(&text);
                }
            }
            _ => {}
        }
    }

    let mut out = if title.is_empty() {
        "Chart:\n".to_string()
    } else {
        format!("Chart: {title}\n")
    };
    for (i, s) in series.iter().enumerate() {
        let name = if s.name.is_empty() {
            format!("Series {}", i + 1)
        } else {
            s.name.clone()
        };
        let points: Vec<String> = s
            .vals
            .iter()
            .take(CHART_MAX_POINTS)
            .enumerate()
            .map(|(j, v)| match s.cats.get(j) {
                Some(c) => format!("{c} {v}"),
                None => v.clone(),
            })
            .collect();
        let more = s.vals.len().saturating_sub(CHART_MAX_POINTS);
        let tail = if more > 0 {
            format!(", … {more} more")
        } else {
            String::new()
        };
        out.push_str(&format!("  {name}: {}{tail}\n", points.join(", ")));
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod test_fixtures {
    use std::io::Write;

    /// A minimal .pptx: one slide per entry of `slides`, each a title and
    /// body paragraphs, with optional notes.
    pub fn tiny_pptx(slides: &[(&str, &[&str], Option<&str>)]) -> Vec<u8> {
        let mut entries: Vec<(String, String)> = Vec::new();
        let mut ids = String::new();
        let mut rels = String::new();
        for (i, (title, body, notes)) in slides.iter().enumerate() {
            let n = i + 1;
            ids.push_str(&format!(r#"<p:sldId id="{}" r:id="rId{n}"/>"#, 255 + n));
            rels.push_str(&format!(
                r#"<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{n}.xml"/>"#
            ));
            let paras: String = body
                .iter()
                .map(|p| format!("<a:p><a:r><a:t>{p}</a:t></a:r></a:p>"))
                .collect();
            entries.push((
                format!("ppt/slides/slide{n}.xml"),
                format!(
                    r#"<p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>{paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
                ),
            ));
            if let Some(notes) = notes {
                entries.push((
                    format!("ppt/slides/_rels/slide{n}.xml.rels"),
                    format!(
                        r#"<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide{n}.xml"/></Relationships>"#
                    ),
                ));
                entries.push((
                    format!("ppt/notesSlides/notesSlide{n}.xml"),
                    format!(
                        r#"<p:notes xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{notes}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{n}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#
                    ),
                ));
            }
        }
        entries.push((
            "ppt/presentation.xml".into(),
            format!(r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>"#),
        ));
        entries.push((
            "ppt/_rels/presentation.xml.rels".into(),
            format!("<Relationships>{rels}</Relationships>"),
        ));
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            zip.start_file(name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::tiny_pptx;
    use super::*;

    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_slides_in_order_with_titles_bodies_and_notes() {
        let bytes = tiny_pptx(&[
            (
                "Q3 review",
                &["Revenue up 12%", "Churn &amp; costs down"],
                Some("Open with the win."),
            ),
            ("Next steps", &["Hire two engineers"], None),
        ]);
        let text = extract_pptx(&bytes).unwrap().text;
        assert_eq!(
            text,
            "## Slide 1: Q3 review\nRevenue up 12%\nChurn & costs down\nNotes:\nOpen with the win.\n\n\
             ## Slide 2: Next steps\nHire two engineers\n\n"
        );
    }

    #[test]
    fn follows_presentation_order_not_file_names() {
        let slide = |t: &str| {
            format!(
                r#"<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
            )
        };
        let (a, b) = (slide("First"), slide("Second"));
        let bytes = zip_of(&[
            (
                "ppt/presentation.xml",
                r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId7"/><p:sldId id="256" r:id="rId3"/></p:sldIdLst></p:presentation>"#,
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                r#"<Relationships><Relationship Id="rId3" Type="x/slide" Target="/ppt/slides/slide1.xml"/><Relationship Id="rId7" Type="x/slide" Target="slides/slide2.xml"/></Relationships>"#,
            ),
            ("ppt/slides/slide1.xml", &b),
            ("ppt/slides/slide2.xml", &a),
        ]);
        let text = extract_pptx(&bytes).unwrap().text;
        assert_eq!(text, "## Slide 1: First\n\n## Slide 2: Second\n\n");
    }

    #[test]
    fn reads_tables_levels_pictures_charts_and_hidden_slides() {
        let slide = r#"<p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r" xmlns:c="c" show="0"><p:cSld><p:spTree>
            <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Plan</a:t></a:r><a:br/><a:r><a:t>2027</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:txBody><a:p><a:r><a:t>Goals</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Ship</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>4</a:t></a:r></a:p></p:txBody></p:sp>
            <p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Sales</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>EU</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>40</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
            <p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>
            <p:pic><p:nvPicPr/></p:pic><p:pic><p:nvPicPr/></p:pic>
            </p:spTree></p:cSld></p:sld>"#;
        let chart = r#"<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales by quarter</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart>
            <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2026</c:v></c:pt></c:strCache></c:strRef></c:tx>
            <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
            <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
            </c:barChart></c:plotArea></c:chart></c:chartSpace>"#;
        let bytes = zip_of(&[
            (
                "ppt/presentation.xml",
                r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#,
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                r#"<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>"#,
            ),
            ("ppt/slides/slide1.xml", slide),
            (
                "ppt/slides/_rels/slide1.xml.rels",
                r#"<Relationships><Relationship Id="rId2" Type="x/chart" Target="../charts/chart1.xml"/><Relationship Id="rId5" Type="x/hyperlink" Target="https://x.y" TargetMode="External"/></Relationships>"#,
            ),
            ("ppt/charts/chart1.xml", chart),
        ]);
        let text = extract_pptx(&bytes).unwrap().text;
        assert_eq!(
            text,
            "## Slide 1: Plan 2027 (hidden)\nGoals\n  Ship\nRegion | Sales\nEU | 40\n\
             Chart: Sales by quarter\n  2026: Q1 10, Q2 12.5\n(2 pictures not included)\n\n"
        );
    }

    #[test]
    fn a_zip_without_a_presentation_is_unreadable() {
        let bytes = zip_of(&[("ppt/slides/slide1.xml", "<p:sld/>")]);
        assert!(matches!(
            extract_pptx(&bytes),
            Err(ExtractFailure::Unreadable(_))
        ));
    }

    #[test]
    fn resolves_relative_and_absolute_targets() {
        assert_eq!(
            resolve("ppt/slides", "../notesSlides/n1.xml"),
            "ppt/notesSlides/n1.xml"
        );
        assert_eq!(resolve("ppt", "slides/slide1.xml"), "ppt/slides/slide1.xml");
        assert_eq!(resolve("ppt/slides", "/ppt/media/a.png"), "ppt/media/a.png");
    }
}
