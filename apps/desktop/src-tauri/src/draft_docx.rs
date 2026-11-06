//! Writing export to Word: a draft's Markdown as a real .docx.
//!
//! Written by hand on `zip` (already a dependency) instead of pulling in a
//! docx crate: the mapping needs only a small, fixed set of parts, and the
//! output stays under our control (see the module tests, which read it back
//! with the same reader chat attachments use).
//!
//! What maps: headings (Heading1-6), paragraphs, bold / italic / strike /
//! inline code, links (real hyperlinks, http(s) and mailto only), bulleted and
//! numbered lists with nesting (real Word numbering; every ordered list
//! restarts at its own start number), task lists, block quotes, code blocks
//! (monospace, one paragraph per line), tables (header row repeats), rules,
//! footnotes (as small paragraphs, not Word footnotes). Raw HTML is kept as
//! literal text, like the HTML export. Front matter is left out. Drafts hold no
//! embedded images, so an image becomes its alt text (linked when its address
//! is http(s)).

use std::io::{Cursor, Write};

use pulldown_cmark::{Alignment, Event, HeadingLevel, LinkType, Parser, Tag, TagEnd};

use crate::draft_blocks;

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
/// Text width between the margins of an A4 page with 1 inch margins, in twips.
const TEXT_WIDTH: usize = 9026;
/// Deepest list level Word numbering has.
const MAX_LEVEL: usize = 8;
const BULLET_NUM_ID: usize = 1;

/// The .docx bytes for a draft titled `title`. `markdown` is the draft body
/// (front matter is skipped). The title goes in the file's properties only: the
/// HTML export does not add a heading for it either.
pub fn build(title: &str, markdown: &str) -> Result<Vec<u8>, String> {
    let body = match draft_blocks::front_matter_end(markdown) {
        Some(end) => &markdown[end..],
        None => markdown,
    };
    let mut doc = Builder::default();
    doc.run_events(body);
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    package(title, &doc, &now).map_err(|e| format!("Couldn't build the Word file: {e}"))
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

fn xml_escape(text: &str) -> String {
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

/// A link address Word may open: http(s) or mailto. Anything else stays text.
fn link_target(url: &str, link_type: LinkType) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if link_type == LinkType::Email {
        return Some(format!("mailto:{url}"));
    }
    let lower = url.to_ascii_lowercase();
    let web = lower.starts_with("http://") || lower.starts_with("https://");
    (web || lower.starts_with("mailto:")).then(|| url.to_string())
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Kind {
    Body,
    Heading(u8),
    Code,
    Cell(Alignment),
}

struct ListCtx {
    /// Word numbering instance: shared for bullets, one per ordered list.
    num_id: usize,
}

struct ItemCtx {
    num_id: usize,
    level: usize,
    /// The item's number or bullet is still to be written.
    first: bool,
}

#[derive(Default)]
struct TableState {
    aligns: Vec<Alignment>,
    rows: Vec<String>,
    cells: String,
    col: usize,
    header: bool,
}

#[derive(Default)]
struct Builder {
    body: String,
    /// External hyperlink targets, in order; relationship id is `rId{3+index}`.
    links: Vec<String>,
    /// Start number of each ordered list; its numbering id is `2 + index`.
    ordered: Vec<u64>,
    lists: Vec<ListCtx>,
    items: Vec<ItemCtx>,
    quote: usize,
    para_open: bool,
    bold: u32,
    italic: u32,
    strike: u32,
    code: bool,
    link: Option<usize>,
    image: Option<(Option<usize>, String)>,
    code_block: Option<String>,
    table: Option<TableState>,
    cell_saved: Option<String>,
    footnote: Option<String>,
    /// A raw HTML line ended; the next text starts on a new line.
    pending_br: bool,
}

impl Builder {
    fn link_id(&mut self, url: String) -> usize {
        match self.links.iter().position(|u| *u == url) {
            Some(i) => i,
            None => {
                self.links.push(url);
                self.links.len() - 1
            }
        }
    }

    fn ppr(&mut self, kind: Kind) -> String {
        let mut style: Option<String> = None;
        let mut numpr = String::new();
        let mut ind: Option<usize> = None;
        let mut jc = "";
        match kind {
            Kind::Heading(level) => style = Some(format!("Heading{level}")),
            Kind::Code => {
                style = Some("CodeBlock".into());
                if let Some(item) = self.items.last() {
                    ind = Some(720 * (item.level + 1));
                }
            }
            Kind::Cell(align) => {
                style = Some("TableText".into());
                jc = match align {
                    Alignment::Center => "center",
                    Alignment::Right => "right",
                    _ => "",
                };
            }
            Kind::Body => {
                if self.footnote.is_some() {
                    style = Some("FootnoteText".into());
                } else if self.quote > 0 {
                    style = Some("Quote".into());
                    if self.quote > 1 {
                        ind = Some(720 * self.quote);
                    }
                } else if !self.items.is_empty() {
                    style = Some("ListParagraph".into());
                }
                if let Some(item) = self.items.last_mut() {
                    if item.first {
                        item.first = false;
                        numpr = format!(
                            "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
                            item.level, item.num_id
                        );
                    } else {
                        ind = Some(720 * (item.level + 1));
                    }
                }
            }
        }
        let mut out = String::new();
        if let Some(style) = style {
            out.push_str(&format!("<w:pStyle w:val=\"{style}\"/>"));
        }
        out.push_str(&numpr);
        if let Some(left) = ind {
            out.push_str(&format!("<w:ind w:left=\"{left}\"/>"));
        }
        if !jc.is_empty() {
            out.push_str(&format!("<w:jc w:val=\"{jc}\"/>"));
        }
        if out.is_empty() {
            String::new()
        } else {
            format!("<w:pPr>{out}</w:pPr>")
        }
    }

    fn open(&mut self, kind: Kind) {
        self.close();
        let ppr = self.ppr(kind);
        self.body.push_str("<w:p>");
        self.body.push_str(&ppr);
        self.para_open = true;
        if matches!(kind, Kind::Body) {
            if let Some(label) = self.footnote.take().filter(|l| !l.is_empty()) {
                // Only the first paragraph of the note carries its label.
                self.footnote = Some(String::new());
                self.raw_run("<w:vertAlign w:val=\"superscript\"/>", &format!("{label} "));
            }
        }
    }

    fn close(&mut self) {
        self.pending_br = false;
        if self.para_open {
            self.body.push_str("</w:p>");
            self.para_open = false;
        }
    }

    fn ensure(&mut self) {
        if !self.para_open {
            self.open(Kind::Body);
        }
    }

    /// One run with `rpr` (inner XML of its run properties) and `text`.
    fn raw_run(&mut self, rpr: &str, text: &str) {
        let mut runs = String::new();
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                runs.push_str(&format!("<w:r>{}<w:br/></w:r>", rpr_xml(rpr)));
            }
            for (j, part) in line.split('\t').enumerate() {
                if j > 0 {
                    runs.push_str(&format!("<w:r>{}<w:tab/></w:r>", rpr_xml(rpr)));
                }
                if !part.is_empty() {
                    runs.push_str(&format!(
                        "<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
                        rpr_xml(rpr),
                        xml_escape(part)
                    ));
                }
            }
        }
        match self.link {
            Some(i) => self.body.push_str(&format!(
                "<w:hyperlink r:id=\"rId{}\" w:history=\"1\">{runs}</w:hyperlink>",
                3 + i
            )),
            None => self.body.push_str(&runs),
        }
    }

    /// Text in the current inline formatting.
    fn text(&mut self, text: &str) {
        self.ensure();
        if std::mem::take(&mut self.pending_br) {
            self.raw_run("", "\n");
        }
        let mut rpr = String::new();
        if self.link.is_some() {
            rpr.push_str("<w:rStyle w:val=\"Hyperlink\"/>");
        } else if self.code {
            rpr.push_str("<w:rStyle w:val=\"InlineCode\"/>");
        }
        if self.bold > 0 {
            rpr.push_str("<w:b/>");
        }
        if self.italic > 0 {
            rpr.push_str("<w:i/>");
        }
        if self.strike > 0 {
            rpr.push_str("<w:strike/>");
        }
        self.raw_run(&rpr, text);
    }

    fn code_text(&mut self, text: &str) {
        let was = std::mem::replace(&mut self.code, true);
        self.text(text);
        self.code = was;
    }

    fn run_events(&mut self, markdown: &str) {
        for event in Parser::new_ext(markdown, draft_blocks::markdown_options()) {
            self.event(event);
        }
        self.close();
    }

    fn event(&mut self, event: Event<'_>) {
        // An image is read for its alt text only.
        if let Some((_, alt)) = self.image.as_mut() {
            match &event {
                Event::Text(t) | Event::Code(t) => alt.push_str(t),
                Event::SoftBreak | Event::HardBreak => alt.push(' '),
                _ => {}
            }
            if !matches!(event, Event::End(TagEnd::Image)) {
                return;
            }
        }
        if let Some(buf) = self.code_block.as_mut() {
            match &event {
                Event::Text(t) => {
                    buf.push_str(t);
                    return;
                }
                Event::End(TagEnd::CodeBlock) => {}
                _ => return,
            }
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => self.text(&t),
            Event::Code(t) => self.code_text(&t),
            // Raw HTML is shown as written, line breaks kept.
            Event::Html(t) => {
                self.text(t.trim_end_matches('\n'));
                self.pending_br = t.ends_with('\n');
            }
            Event::InlineHtml(t) => self.text(&t),
            Event::SoftBreak => self.text(" "),
            Event::HardBreak => self.text("\n"),
            Event::Rule => {
                self.close();
                self.body.push_str(
                    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" \
                     w:color=\"A6A6A6\"/></w:pBdr></w:pPr></w:p>",
                );
            }
            Event::TaskListMarker(done) => self.text(if done { "\u{2611} " } else { "\u{2610} " }),
            Event::FootnoteReference(label) => {
                self.ensure();
                self.raw_run("<w:vertAlign w:val=\"superscript\"/>", &label);
            }
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph | Tag::HtmlBlock => self.open(Kind::Body),
            Tag::Heading { level, .. } => self.open(Kind::Heading(match level {
                HeadingLevel::H1 => 1,
                HeadingLevel::H2 => 2,
                HeadingLevel::H3 => 3,
                HeadingLevel::H4 => 4,
                HeadingLevel::H5 => 5,
                HeadingLevel::H6 => 6,
            })),
            Tag::BlockQuote(_) => {
                self.close();
                self.quote += 1;
            }
            Tag::CodeBlock(_) => {
                self.close();
                self.code_block = Some(String::new());
            }
            Tag::List(start) => {
                self.close();
                let num_id = match start {
                    None => BULLET_NUM_ID,
                    Some(n) => {
                        self.ordered.push(n);
                        1 + self.ordered.len()
                    }
                };
                self.lists.push(ListCtx { num_id });
            }
            Tag::Item => {
                self.close();
                let num_id = self.lists.last().map_or(BULLET_NUM_ID, |l| l.num_id);
                let level = self.lists.len().saturating_sub(1).min(MAX_LEVEL);
                self.items.push(ItemCtx {
                    num_id,
                    level,
                    first: true,
                });
            }
            Tag::FootnoteDefinition(label) => {
                self.close();
                self.footnote = Some(label.to_string());
            }
            Tag::Table(aligns) => {
                self.close();
                self.table = Some(TableState {
                    aligns,
                    ..TableState::default()
                });
            }
            Tag::TableHead => {
                if let Some(t) = self.table.as_mut() {
                    t.header = true;
                    t.cells.clear();
                    t.col = 0;
                }
                self.bold += 1;
            }
            Tag::TableRow => {
                if let Some(t) = self.table.as_mut() {
                    t.cells.clear();
                    t.col = 0;
                }
            }
            Tag::TableCell => {
                let align = self
                    .table
                    .as_ref()
                    .and_then(|t| t.aligns.get(t.col).copied())
                    .unwrap_or(Alignment::None);
                self.cell_saved = Some(std::mem::take(&mut self.body));
                self.open(Kind::Cell(align));
            }
            Tag::Emphasis => self.italic += 1,
            Tag::Strong => self.bold += 1,
            Tag::Strikethrough => self.strike += 1,
            Tag::Link {
                link_type,
                dest_url,
                ..
            } => {
                self.link = link_target(&dest_url, link_type).map(|u| self.link_id(u));
            }
            Tag::Image { dest_url, .. } => {
                let id = link_target(&dest_url, LinkType::Inline).map(|u| self.link_id(u));
                self.image = Some((id, String::new()));
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::HtmlBlock | TagEnd::Heading(_) => self.close(),
            TagEnd::BlockQuote(_) => {
                self.close();
                self.quote = self.quote.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                let text = self.code_block.take().unwrap_or_default();
                let text = text.strip_suffix('\n').unwrap_or(&text);
                for line in text.split('\n') {
                    self.open(Kind::Code);
                    if !line.is_empty() {
                        self.raw_run("", line);
                    }
                    self.close();
                }
            }
            TagEnd::List(_) => {
                self.close();
                self.lists.pop();
            }
            TagEnd::Item => {
                self.close();
                if self.items.last().is_some_and(|i| i.first) {
                    // An empty item still shows its number or bullet.
                    self.open(Kind::Body);
                    self.close();
                }
                self.items.pop();
            }
            TagEnd::FootnoteDefinition => {
                self.close();
                self.footnote = None;
            }
            TagEnd::TableCell => {
                self.close();
                let saved = self.cell_saved.take().unwrap_or_default();
                let content = std::mem::replace(&mut self.body, saved);
                if let Some(t) = self.table.as_mut() {
                    let width = TEXT_WIDTH / t.aligns.len().max(1);
                    let shade = if t.header {
                        "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/>"
                    } else {
                        ""
                    };
                    t.cells.push_str(&format!(
                        "<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/>{shade}</w:tcPr>{content}</w:tc>"
                    ));
                    t.col += 1;
                }
            }
            TagEnd::TableHead | TagEnd::TableRow => {
                let head = matches!(tag, TagEnd::TableHead);
                if head {
                    self.bold = self.bold.saturating_sub(1);
                }
                if let Some(t) = self.table.as_mut() {
                    let props = if head {
                        "<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>"
                    } else {
                        "<w:trPr><w:cantSplit/></w:trPr>"
                    };
                    let row = format!("<w:tr>{props}{}</w:tr>", t.cells);
                    t.rows.push(row);
                    t.cells.clear();
                    t.header = false;
                }
            }
            TagEnd::Table => {
                if let Some(t) = self.table.take() {
                    let n = t.aligns.len().max(1);
                    let grid: String = (0..n)
                        .map(|_| format!("<w:gridCol w:w=\"{}\"/>", TEXT_WIDTH / n))
                        .collect();
                    self.body.push_str(&format!(
                        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/>\
                         <w:tblW w:w=\"{TEXT_WIDTH}\" w:type=\"dxa\"/>\
                         <w:tblLayout w:type=\"fixed\"/>\
                         <w:tblLook w:val=\"0420\" w:firstRow=\"1\" w:lastRow=\"0\" \
                         w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/>\
                         </w:tblPr><w:tblGrid>{grid}</w:tblGrid>{}</w:tbl><w:p/>",
                        t.rows.concat()
                    ));
                }
            }
            TagEnd::Emphasis => self.italic = self.italic.saturating_sub(1),
            TagEnd::Strong => self.bold = self.bold.saturating_sub(1),
            TagEnd::Strikethrough => self.strike = self.strike.saturating_sub(1),
            TagEnd::Link => self.link = None,
            TagEnd::Image => {
                if let Some((id, alt)) = self.image.take() {
                    let alt = alt.split_whitespace().collect::<Vec<_>>().join(" ");
                    let label = if alt.is_empty() {
                        "[image]".to_string()
                    } else {
                        format!("[image: {alt}]")
                    };
                    self.link = id;
                    self.text(&label);
                    self.link = None;
                }
            }
            _ => {}
        }
    }
}

fn rpr_xml(inner: &str) -> String {
    if inner.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{inner}</w:rPr>")
    }
}

// ---------------------------------------------------------------------------
// Package parts
// ---------------------------------------------------------------------------

fn package(title: &str, doc: &Builder, now: &str) -> Result<Vec<u8>, std::io::Error> {
    let content_types = format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
         <Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
         <Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
         <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
         </Types>"
    );
    let root_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"{REL_BASE}/officeDocument\" Target=\"word/document.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
         </Relationships>"
    );
    let mut doc_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"{REL_BASE}/styles\" Target=\"styles.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"{REL_BASE}/numbering\" Target=\"numbering.xml\"/>"
    );
    for (i, url) in doc.links.iter().enumerate() {
        doc_rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"{REL_BASE}/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            3 + i,
            xml_escape(url)
        ));
    }
    doc_rels.push_str("</Relationships>");
    let document = format!(
        "{XML_DECL}<w:document xmlns:w=\"{NS_W}\" xmlns:r=\"{NS_R}\"><w:body>{}\
         <w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
         <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" \
         w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>",
        doc.body
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
        xml_escape(title.trim())
    );

    let mut out = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default();
        let parts: [(&str, String); 7] = [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", root_rels),
            ("word/document.xml", document),
            ("word/_rels/document.xml.rels", doc_rels),
            ("word/styles.xml", styles_xml()),
            ("word/numbering.xml", numbering_xml(&doc.ordered)),
            ("docProps/core.xml", core),
        ];
        for (name, body) in parts {
            zip.start_file(name, options)?;
            zip.write_all(body.as_bytes())?;
        }
        zip.finish()?;
    }
    Ok(out.into_inner())
}

fn numbering_xml(ordered: &[u64]) -> String {
    let mut out = format!("{XML_DECL}<w:numbering xmlns:w=\"{NS_W}\">");
    // Bullets.
    out.push_str(
        "<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"hybridMultilevel\"/>",
    );
    for level in 0..=MAX_LEVEL {
        let glyph = ["\u{2022}", "\u{25E6}", "\u{25AA}"][level % 3];
        out.push_str(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/>\
             <w:lvlText w:val=\"{glyph}\"/><w:lvlJc w:val=\"left\"/>\
             <w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            720 * (level + 1)
        ));
    }
    out.push_str("</w:abstractNum>");
    // Numbers.
    out.push_str(
        "<w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"hybridMultilevel\"/>",
    );
    for level in 0..=MAX_LEVEL {
        let fmt = ["decimal", "lowerLetter", "lowerRoman"][level % 3];
        out.push_str(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/>\
             <w:lvlText w:val=\"%{}.\"/><w:lvlJc w:val=\"left\"/>\
             <w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            level + 1,
            720 * (level + 1)
        ));
    }
    out.push_str("</w:abstractNum>");
    out.push_str(&format!(
        "<w:num w:numId=\"{BULLET_NUM_ID}\"><w:abstractNumId w:val=\"0\"/></w:num>"
    ));
    for (i, start) in ordered.iter().enumerate() {
        out.push_str(&format!(
            "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"1\"/>",
            2 + i
        ));
        // Every level restarts, so a list never continues an earlier one.
        for level in 0..=MAX_LEVEL {
            out.push_str(&format!(
                "<w:lvlOverride w:ilvl=\"{level}\"><w:startOverride w:val=\"{}\"/></w:lvlOverride>",
                if level == 0 { *start } else { 1 }
            ));
        }
        out.push_str("</w:num>");
    }
    out.push_str("</w:numbering>");
    out
}

fn heading_style(level: u8, size: u32, before: u32) -> String {
    format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"Heading{level}\"><w:name w:val=\"heading {level}\"/>\
         <w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/>\
         <w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"{before}\" w:after=\"120\"/>\
         <w:outlineLvl w:val=\"{}\"/></w:pPr>\
         <w:rPr><w:b/><w:color w:val=\"1F2937\"/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>",
        level - 1
    )
}

fn styles_xml() -> String {
    let mono = "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\" w:eastAsia=\"Consolas\"/>";
    let mut out = format!(
        "{XML_DECL}<w:styles xmlns:w=\"{NS_W}\"><w:docDefaults><w:rPrDefault><w:rPr>\
         <w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:cs=\"Calibri\"/>\
         <w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault>\
         <w:pPrDefault><w:pPr><w:spacing w:after=\"160\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault>\
         </w:docDefaults>\
         <w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>\
         <w:style w:type=\"character\" w:default=\"1\" w:styleId=\"DefaultParagraphFont\"><w:name w:val=\"Default Paragraph Font\"/><w:uiPriority w:val=\"1\"/><w:semiHidden/></w:style>\
         <w:style w:type=\"table\" w:default=\"1\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/><w:uiPriority w:val=\"99\"/><w:semiHidden/>\
         <w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"108\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>"
    );
    for (level, size, before) in [
        (1u8, 36u32, 360u32),
        (2, 30, 320),
        (3, 26, 280),
        (4, 24, 240),
        (5, 22, 240),
        (6, 22, 240),
    ] {
        out.push_str(&heading_style(level, size, before));
    }
    out.push_str(&format!(
        "<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:basedOn w:val=\"DefaultParagraphFont\"/><w:uiPriority w:val=\"99\"/>\
         <w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>\
         <w:style w:type=\"character\" w:styleId=\"InlineCode\"><w:name w:val=\"Inline Code\"/><w:basedOn w:val=\"DefaultParagraphFont\"/><w:qFormat/>\
         <w:rPr>{mono}<w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/></w:rPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"CodeBlock\"><w:name w:val=\"Code Block\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>\
         <w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:contextualSpacing/></w:pPr>\
         <w:rPr>{mono}<w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/></w:rPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>\
         <w:pPr><w:pBdr><w:left w:val=\"single\" w:sz=\"18\" w:space=\"8\" w:color=\"BFBFBF\"/></w:pBdr><w:ind w:left=\"720\"/></w:pPr>\
         <w:rPr><w:color w:val=\"595959\"/></w:rPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"34\"/><w:qFormat/>\
         <w:pPr><w:spacing w:after=\"80\"/><w:ind w:left=\"720\"/></w:pPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"TableText\"><w:name w:val=\"Table Text\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>\
         <w:pPr><w:spacing w:before=\"40\" w:after=\"40\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"FootnoteText\"><w:name w:val=\"footnote text\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"99\"/>\
         <w:pPr><w:spacing w:after=\"60\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/></w:rPr></w:style>\
         <w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:basedOn w:val=\"TableNormal\"/><w:uiPriority w:val=\"39\"/>\
         <w:tblPr><w:tblBorders>\
         <w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
         <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
         <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
         </w:tblBorders></w:tblPr></w:style></w:styles>"
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::extract::extract_document_bytes;
    use std::io::Read;

    fn part(bytes: &[u8], name: &str) -> String {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut s = String::new();
        zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    async fn read_back(bytes: Vec<u8>) -> String {
        extract_document_bytes(bytes, "docx").await.unwrap().text
    }

    const RICH: &str = "---\nsecret: hidden\n---\n\n\
# Tea & Water\n\n\
Intro with **bold**, *italic*, ~~gone~~, `code` and a [link](https://example.org/a?x=1&y=2).\n\n\
## Steps\n\n\
1. Boil\n2. Pour\n   - Slowly\n   - Evenly\n3. Wait\n\n\
- [x] Done thing\n- [ ] Open thing\n\n\
> Quoted wisdom\n\n\
```rust\nfn main() {\n\n    println!(\"hi\");\n}\n```\n\n\
| Leaf | Temp |\n|:-----|-----:|\n| Green | 80 |\n| Black | 95 |\n\n\
---\n\n\
Footnote ref[^1] and an image ![a cup](https://img.example/cup.png).\n\n\
[^1]: The note.\n\n\
<script>alert(1)</script>\n";

    #[tokio::test]
    async fn rich_draft_reads_back_in_order() {
        let bytes = build("Tea", &crate::draft_export::with_sources(RICH)).unwrap();
        let text = read_back(bytes).await;
        assert!(!text.contains("secret"), "{text}");
        let order = [
            "Tea & Water",
            "Intro with bold, italic, gone, code and a link.",
            "Steps",
            "Boil",
            "Pour",
            "Slowly",
            "Evenly",
            "Wait",
            "\u{2611} Done thing",
            "\u{2610} Open thing",
            "Quoted wisdom",
            "fn main() {",
            "    println!(\"hi\");",
            "}",
            "Leaf",
            "Temp",
            "Green",
            "80",
            "Black",
            "95",
            "Footnote ref1 and an image [image: a cup].",
            "1 The note.",
            "<script>alert(1)</script>",
            "Sources",
            "link",
        ];
        let mut at = 0;
        for want in order {
            let found = text[at..]
                .find(want)
                .unwrap_or_else(|| panic!("`{want}` missing after byte {at} in:\n{text}"));
            at += found + want.len();
        }
        // Lists keep one paragraph per item, nothing like a typed bullet.
        assert!(text.contains("\nPour\nSlowly\nEvenly\nWait\n"), "{text}");
        assert!(!text.contains("1. Boil"), "{text}");
    }

    #[test]
    fn structure_uses_word_styles_numbering_and_hyperlinks() {
        let bytes = build("Tea <&> Co", RICH).unwrap();
        let doc = part(&bytes, "word/document.xml");
        for h in ["Heading1", "Heading2"] {
            assert!(doc.contains(&format!("<w:pStyle w:val=\"{h}\"/>")), "{h}");
        }
        assert!(doc.contains("<w:b/>") && doc.contains("<w:i/>") && doc.contains("<w:strike/>"));
        assert!(doc.contains("w:val=\"InlineCode\""));
        assert!(doc.contains("<w:tbl>") && doc.contains("<w:tblHeader/>"));
        assert!(doc.contains("<w:jc w:val=\"right\"/>"));
        assert!(doc.contains("w:val=\"CodeBlock\""));
        assert!(doc.contains("w:val=\"Quote\""));
        assert!(doc.contains("<w:pBdr><w:bottom"));
        // Numbered list items at level 0, nested bullets at level 1.
        assert!(
            doc.contains("<w:ilvl w:val=\"0\"/><w:numId w:val=\"2\"/>"),
            "{doc}"
        );
        assert!(
            doc.contains("<w:ilvl w:val=\"1\"/><w:numId w:val=\"1\"/>"),
            "{doc}"
        );
        // Raw HTML stays literal text.
        assert!(doc.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        let rels = part(&bytes, "word/_rels/document.xml.rels");
        assert!(
            rels.contains("Target=\"https://example.org/a?x=1&amp;y=2\" TargetMode=\"External\""),
            "{rels}"
        );
        assert!(doc.contains("<w:hyperlink r:id=\"rId3\""));
        let core = part(&bytes, "docProps/core.xml");
        assert!(
            core.contains("<dc:title>Tea &lt;&amp;&gt; Co</dc:title>"),
            "{core}"
        );
    }

    #[test]
    fn every_part_is_well_formed_xml() {
        let bytes = build("T", RICH).unwrap();
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
            "docProps/core.xml",
        ] {
            let xml = part(&bytes, name);
            let mut reader = quick_xml::Reader::from_str(&xml);
            loop {
                match reader.read_event() {
                    Ok(quick_xml::events::Event::Eof) => break,
                    Ok(_) => {}
                    Err(e) => panic!("{name}: {e}"),
                }
            }
        }
    }

    #[test]
    fn ordered_lists_restart_and_keep_their_start_number() {
        let md = "1. a\n2. b\n\ntext\n\n5. c\n6. d\n";
        let bytes = build("T", md).unwrap();
        let num = part(&bytes, "word/numbering.xml");
        assert!(num.contains("<w:num w:numId=\"2\"><w:abstractNumId w:val=\"1\"/>"));
        assert!(num.contains("<w:num w:numId=\"3\"><w:abstractNumId w:val=\"1\"/>"));
        assert!(num.contains("<w:startOverride w:val=\"5\"/>"), "{num}");
        let doc = part(&bytes, "word/document.xml");
        assert!(doc.contains("<w:numId w:val=\"3\"/>"));
    }

    #[tokio::test]
    async fn loose_lists_nested_quotes_and_empty_input_survive() {
        let md = "- one\n\n  more about one\n\n- two\n\n> outer\n>\n> > inner\n";
        let text = read_back(build("T", md).unwrap()).await;
        assert_eq!(text, "one\nmore about one\ntwo\nouter\ninner");
        // An empty draft is still a valid document.
        let empty = build("T", "").unwrap();
        assert!(part(&empty, "word/document.xml").contains("<w:body>"));
    }

    #[test]
    fn unsafe_links_stay_text_and_autolinks_link() {
        let md = "[bad](javascript:alert(1)) [rel](./a.md) <https://auto.example/x> <me@a.example>";
        let bytes = build("T", md).unwrap();
        let rels = part(&bytes, "word/_rels/document.xml.rels");
        assert!(!rels.contains("javascript"), "{rels}");
        assert!(!rels.contains("a.md"), "{rels}");
        assert!(rels.contains("Target=\"https://auto.example/x\""));
        assert!(rels.contains("Target=\"mailto:me@a.example\""));
    }

    /// Writes a rich sample for opening in Word when `DOCX_SAMPLE_OUT` is set.
    #[test]
    fn writes_a_sample_when_asked() {
        let Ok(path) = std::env::var("DOCX_SAMPLE_OUT") else {
            return;
        };
        let md = crate::draft_export::with_sources(RICH);
        std::fs::write(path, build("Tea & Water", &md).unwrap()).unwrap();
    }
}
