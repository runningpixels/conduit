//! Documents attached to a chat message: what they are and how they reach the
//! model.
//!
//! A chat attachment is either an image (handled by `vision.rs` as before), a
//! document this module reads (PDF, DOCX, plain text / Markdown / CSV), or
//! something nothing reads yet (xlsx, pptx, zip…). The kind is decided here by
//! **sniffing the bytes**, never by trusting the MIME type the renderer sent:
//! a browser reports `.md` as nothing at all and `.csv` as an Excel type, and a
//! renamed file says whatever its name says.
//!
//! Every document reaches every model as text extracted locally (the same
//! extractors the Documents knowledge base uses), wrapped in an
//! `<attachment …>` element so the model knows where the file starts and ends
//! and how much of it it got. A PDF additionally goes as the PDF itself to a
//! model that reads PDFs (`provider_core::model_accepts_pdf`), so scanned
//! pages and charts work there; that decision lives in `vision.rs`, which
//! does the per-request hydration, and in [`decide_delivery`], which the
//! composer asks so its chip says exactly what the send path will do.
//!
//! Extraction is cached in memory by attachment id: every later turn of a
//! conversation re-sends (and so re-hydrates) the whole history, and
//! re-parsing a 300-page PDF on each turn would stall every reply.

use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::knowledge::extract::{extract_document_bytes, ExtractFailure};

pub const PDF_MIME: &str = "application/pdf";
pub const DOCX_MIME: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// Largest PDF sent to a model as the PDF itself. Above it the PDF still
/// reaches the model, as extracted text. Matches the image forward cap: the
/// base64 payload grows by a third and providers cap request bodies near here.
pub const PDF_FORWARD_MAX_BYTES: usize = 20 * 1024 * 1024;
/// Most characters of one document's text included in a request. A long
/// report is still useful from its first 150 000 characters, and the element
/// says how long the whole document is so the model can say what it missed.
pub const DOCUMENT_TEXT_MAX_CHARS: usize = 150_000;
/// Most characters of document text across one whole request (history
/// included). Attachments past the budget get a truncation note instead of
/// their text, so a conversation with many documents cannot blow past every
/// model's context window on its own.
pub const REQUEST_TEXT_MAX_CHARS: usize = 300_000;
/// How many extracted documents are kept in memory. A conversation rarely has
/// more live documents than this, and each entry is at most
/// [`DOCUMENT_TEXT_MAX_CHARS`] characters.
const EXTRACTION_CACHE_ENTRIES: usize = 8;

/// The plain-text flavours read as UTF-8 (lossy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextFlavor {
    Plain,
    Markdown,
    Csv,
}

/// A document kind this module reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Pdf,
    Docx,
    Text(TextFlavor),
}

impl DocumentKind {
    /// The MIME type stored and sent for this kind.
    pub fn mime(self) -> &'static str {
        match self {
            DocumentKind::Pdf => PDF_MIME,
            DocumentKind::Docx => DOCX_MIME,
            DocumentKind::Text(TextFlavor::Plain) => "text/plain",
            DocumentKind::Text(TextFlavor::Markdown) => "text/markdown",
            DocumentKind::Text(TextFlavor::Csv) => "text/csv",
        }
    }

    /// The extension that selects this kind's extractor, also used as the
    /// `kind` attribute of the `<attachment>` element.
    pub fn extension(self) -> &'static str {
        match self {
            DocumentKind::Pdf => "pdf",
            DocumentKind::Docx => "docx",
            DocumentKind::Text(TextFlavor::Plain) => "txt",
            DocumentKind::Text(TextFlavor::Markdown) => "md",
            DocumentKind::Text(TextFlavor::Csv) => "csv",
        }
    }
}

/// What kind of document `bytes` is, or `None` when it is not one this module
/// reads.
///
/// PDF and DOCX are recognised by their bytes alone (`%PDF-`; a zip archive
/// holding `word/document.xml`), whatever the file is called. Plain text has
/// no signature, so it needs both: bytes that do not look binary, and a name
/// (`.txt`, `.md`, `.markdown`, `.csv`) or claimed type (`text/*`) saying it is
/// text. A `.txt` that is really a zip stays unsupported.
pub fn sniff_document(
    bytes: &[u8],
    filename: Option<&str>,
    claimed_mime: Option<&str>,
) -> Option<DocumentKind> {
    if bytes.starts_with(b"%PDF-") {
        return Some(DocumentKind::Pdf);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return is_docx(bytes).then_some(DocumentKind::Docx);
    }
    if crate::workspace_tools::tools::looks_binary(bytes) {
        return None;
    }
    let by_extension = match extension_of(filename).as_deref() {
        Some("txt" | "text") => Some(TextFlavor::Plain),
        Some("md" | "markdown" | "mdown") => Some(TextFlavor::Markdown),
        Some("csv") => Some(TextFlavor::Csv),
        _ => None,
    };
    let flavor = by_extension.or_else(|| {
        let claimed = claimed_mime?.trim().to_ascii_lowercase();
        let essence = claimed.split(';').next().unwrap_or("").trim();
        match essence {
            "text/csv" => Some(TextFlavor::Csv),
            "text/markdown" | "text/x-markdown" => Some(TextFlavor::Markdown),
            m if m.starts_with("text/") => Some(TextFlavor::Plain),
            _ => None,
        }
    })?;
    Some(DocumentKind::Text(flavor))
}

/// A zip archive with a `word/document.xml` entry. Only the central directory
/// is read, nothing is inflated.
fn is_docx(bytes: &[u8]) -> bool {
    zip::ZipArchive::new(Cursor::new(bytes))
        .map(|archive| archive.index_for_name("word/document.xml").is_some())
        .unwrap_or(false)
}

fn extension_of(filename: Option<&str>) -> Option<String> {
    let name = filename?.trim();
    let (_, ext) = name.rsplit_once('.')?;
    let ext = ext.trim().to_ascii_lowercase();
    let plausible =
        !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric());
    plausible.then_some(ext)
}

/// How one attachment reaches the model, as the composer's chip reports it.
/// Serialised as `{ kind: "image" | "pdf_native" | "text" | "unsupported",
/// reason?: string }` (`AttachmentDelivery` in `src/ipc/contracts.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttachmentDelivery {
    pub kind: DeliveryKind,
    /// For `unsupported` only: a short English noun phrase naming what is not
    /// sent ("xlsx files"). The renderer builds the translated sentence
    /// around it; `None` when there is nothing better than "this file type".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryKind {
    Image,
    PdfNative,
    Text,
    Unsupported,
}

impl AttachmentDelivery {
    fn of(kind: DeliveryKind) -> Self {
        Self { kind, reason: None }
    }

    fn unsupported(reason: Option<String>) -> Self {
        Self {
            kind: DeliveryKind::Unsupported,
            reason,
        }
    }
}

/// How an attachment with these bytes reaches a model that does
/// (`images_ok`) or does not take images, and does (`pdf_ok`) or does not
/// read PDFs. The same order of checks `vision::hydrate_request_for_vision`
/// applies, so the chip and the send path cannot disagree: PDF/DOCX by
/// signature, then images, then text.
pub fn decide_delivery(
    bytes: &[u8],
    filename: Option<&str>,
    claimed_mime: Option<&str>,
    images_ok: bool,
    pdf_ok: bool,
) -> AttachmentDelivery {
    let document = sniff_document(bytes, filename, claimed_mime);
    match document {
        Some(DocumentKind::Pdf) if pdf_ok && bytes.len() <= PDF_FORWARD_MAX_BYTES => {
            return AttachmentDelivery::of(DeliveryKind::PdfNative);
        }
        Some(DocumentKind::Pdf | DocumentKind::Docx) => {
            return AttachmentDelivery::of(DeliveryKind::Text);
        }
        _ => {}
    }
    if crate::vision::resolve_image_mime(bytes, claimed_mime).is_some() {
        return if !images_ok {
            AttachmentDelivery::unsupported(Some("images for this model".to_string()))
        } else if bytes.len() > crate::vision::VISION_FORWARD_MAX_BYTES {
            AttachmentDelivery::unsupported(Some("images over 20 MB".to_string()))
        } else {
            AttachmentDelivery::of(DeliveryKind::Image)
        };
    }
    if document.is_some() {
        return AttachmentDelivery::of(DeliveryKind::Text);
    }
    AttachmentDelivery::unsupported(unsupported_reason(bytes, filename))
}

/// "xlsx files", from the file's name, else from what its bytes look like.
fn unsupported_reason(bytes: &[u8], filename: Option<&str>) -> Option<String> {
    let ext = extension_of(filename).or_else(|| infer::get(bytes).map(|k| k.extension().into()))?;
    Some(format!("{ext} files"))
}

/// A document's extracted text, as cached and as rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentText {
    /// The text, already cut to [`DOCUMENT_TEXT_MAX_CHARS`]; `total_chars` is
    /// the length of the whole extraction.
    Text { text: String, total_chars: usize },
    /// Parsed fine but held no text: a scanned PDF, or an empty file.
    NoTextLayer,
    /// Corrupt, too large, timed out, or the parser panicked.
    Unreadable,
}

struct ExtractionCache {
    entries: VecDeque<(String, DocumentText)>,
}

impl ExtractionCache {
    fn get(&mut self, id: &str) -> Option<DocumentText> {
        let pos = self.entries.iter().position(|(key, _)| key == id)?;
        // Most recently used goes to the back.
        let entry = self.entries.remove(pos)?;
        let value = entry.1.clone();
        self.entries.push_back(entry);
        Some(value)
    }

    fn insert(&mut self, id: String, value: DocumentText) {
        self.entries.retain(|(key, _)| *key != id);
        while self.entries.len() >= EXTRACTION_CACHE_ENTRIES {
            self.entries.pop_front();
        }
        self.entries.push_back((id, value));
    }
}

fn cache() -> &'static Mutex<ExtractionCache> {
    static CACHE: OnceLock<Mutex<ExtractionCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(ExtractionCache {
            entries: VecDeque::new(),
        })
    })
}

/// The text of attachment `attachment_id`, from the cache or by extracting
/// `bytes` as `kind`. A stored attachment's bytes never change (the blob is
/// content-addressed and the row is never rewritten), so the id is a safe key.
/// Failures are cached too: a scan stays a scan on the next turn.
pub async fn document_text(
    attachment_id: &str,
    bytes: Vec<u8>,
    kind: DocumentKind,
) -> DocumentText {
    if let Some(hit) = cache().lock().ok().and_then(|mut c| c.get(attachment_id)) {
        return hit;
    }
    let result = match extract_document_bytes(bytes, kind.extension()).await {
        Ok(extracted) => {
            let total_chars = extracted.text.chars().count();
            let text = if total_chars > DOCUMENT_TEXT_MAX_CHARS {
                extracted
                    .text
                    .chars()
                    .take(DOCUMENT_TEXT_MAX_CHARS)
                    .collect()
            } else {
                extracted.text
            };
            DocumentText::Text { text, total_chars }
        }
        Err(ExtractFailure::NoTextLayer) => DocumentText::NoTextLayer,
        Err(err) => {
            tracing::warn!(
                attachment_id = %attachment_id,
                error = %err,
                "could not extract text from an attached document"
            );
            DocumentText::Unreadable
        }
    };
    if let Ok(mut c) = cache().lock() {
        c.insert(attachment_id.to_string(), result.clone());
    }
    result
}

/// The `<attachment …>` element for one document, spending from `budget` (the
/// characters of document text still allowed in this request).
///
/// `name` is the file's original name. `chars` is always the length of the
/// whole document and `truncated` whether the model got less than that, so it
/// can say what it did not see instead of answering as if it read everything.
pub fn render_attachment(
    name: &str,
    kind: DocumentKind,
    text: &DocumentText,
    budget: &mut usize,
) -> String {
    let name = escape_attr(name);
    let kind_attr = kind.extension();
    match text {
        DocumentText::Text { text, total_chars } => {
            let available = text.chars().count();
            let shown_chars = available.min(*budget);
            *budget -= shown_chars;
            let truncated = shown_chars < *total_chars;
            let shown: String = if shown_chars < available {
                text.chars().take(shown_chars).collect()
            } else {
                text.clone()
            };
            let mut out = format!(
                "<attachment name=\"{name}\" kind=\"{kind_attr}\" chars=\"{total_chars}\" truncated=\"{truncated}\">\n"
            );
            if !shown.is_empty() {
                out.push_str(&shown);
                out.push('\n');
            }
            if shown_chars < available {
                out.push_str(&format!(
                    "[Truncated: this request's limit of {REQUEST_TEXT_MAX_CHARS} characters of attached text was reached; {shown_chars} of {total_chars} characters are included.]\n"
                ));
            } else if truncated {
                out.push_str(&format!(
                    "[Truncated: only the first {shown_chars} of {total_chars} characters are included.]\n"
                ));
            }
            out.push_str("</attachment>");
            out
        }
        DocumentText::NoTextLayer if kind == DocumentKind::Pdf => format!(
            "<attachment name=\"{name}\" kind=\"pdf\" error=\"no text layer\">This PDF has no text layer (a scan); this model cannot read it.</attachment>"
        ),
        DocumentText::NoTextLayer => format!(
            "<attachment name=\"{name}\" kind=\"{kind_attr}\" error=\"empty\">This file has no text.</attachment>"
        ),
        DocumentText::Unreadable => format!(
            "<attachment name=\"{name}\" kind=\"{kind_attr}\" error=\"could not read\">This file could not be read.</attachment>"
        ),
    }
}

fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' | '\r' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Tiny, valid document fixtures for unit tests in this crate.
#[cfg(test)]
pub(crate) mod test_fixtures {
    use std::io::Write;

    /// A one-page PDF saying `line`, with a correct cross-reference table.
    /// `None` makes a page with no text at all: what a scan looks like to a
    /// text extractor.
    pub fn tiny_pdf(line: Option<&str>) -> Vec<u8> {
        let content = match line {
            Some(line) => format!("BT /F1 18 Tf 72 700 Td ({line}) Tj ET"),
            None => "0 0 m 10 10 l S".to_string(),
        };
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
             /Resources << /Font << /F1 5 0 R >> >> >>"
                .to_string(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    /// A minimal DOCX: one paragraph per entry of `paragraphs`.
    pub fn tiny_docx(paragraphs: &[&str]) -> Vec<u8> {
        let body: String = paragraphs
            .iter()
            .map(|p| format!("<w:p><w:r><w:t>{p}</w:t></w:r></w:p>"))
            .collect();
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
             <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
             <w:body>{body}</w:body></w:document>"
        );
        zip_with(&[("word/document.xml", xml.as_str())])
    }

    /// A zip archive holding these entries (deflated).
    pub fn zip_with(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        out.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::{tiny_docx, tiny_pdf, zip_with};
    use super::*;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0xD4, 0xEF, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn sniffs_pdf_and_docx_by_bytes_whatever_the_name() {
        let pdf = tiny_pdf(Some("hi"));
        assert_eq!(
            sniff_document(&pdf, Some("notes.txt"), Some("text/plain")),
            Some(DocumentKind::Pdf)
        );
        let docx = tiny_docx(&["hi"]);
        assert_eq!(
            sniff_document(&docx, Some("download"), Some("application/octet-stream")),
            Some(DocumentKind::Docx)
        );
    }

    #[test]
    fn a_zip_that_is_not_a_docx_is_not_a_document() {
        let xlsx = zip_with(&[("xl/workbook.xml", "<workbook/>")]);
        assert_eq!(
            sniff_document(&xlsx, Some("report.docx"), Some(DOCX_MIME)),
            None
        );
    }

    #[test]
    fn text_needs_a_text_name_or_type_and_text_bytes() {
        let text = b"a,b\n1,2\n";
        assert_eq!(
            sniff_document(text, Some("data.CSV"), Some("application/vnd.ms-excel")),
            Some(DocumentKind::Text(TextFlavor::Csv))
        );
        assert_eq!(
            sniff_document(text, Some("README.md"), None),
            Some(DocumentKind::Text(TextFlavor::Markdown))
        );
        assert_eq!(
            sniff_document(text, Some("notes.markdown"), None),
            Some(DocumentKind::Text(TextFlavor::Markdown))
        );
        assert_eq!(
            sniff_document(text, Some("notes.txt"), None),
            Some(DocumentKind::Text(TextFlavor::Plain))
        );
        assert_eq!(
            sniff_document(text, None, Some("text/csv; charset=utf-8")),
            Some(DocumentKind::Text(TextFlavor::Csv))
        );
        assert_eq!(
            sniff_document(text, Some("blob"), Some("text/x-log")),
            Some(DocumentKind::Text(TextFlavor::Plain))
        );
        // Text bytes, but nothing says it is text.
        assert_eq!(sniff_document(text, Some("data.bin"), None), None);
        // Says text, but the bytes are binary.
        assert_eq!(
            sniff_document(b"ab\0cd", Some("notes.txt"), Some("text/plain")),
            None
        );
    }

    #[test]
    fn delivery_decision_table() {
        let pdf = tiny_pdf(Some("hi"));
        let docx = tiny_docx(&["hi"]);
        let csv = b"a,b\n".to_vec();
        let xlsx = zip_with(&[("xl/workbook.xml", "<workbook/>")]);
        let d = |bytes: &[u8], name: &str, mime: &str, images: bool, pdf_ok: bool| {
            decide_delivery(bytes, Some(name), Some(mime), images, pdf_ok)
        };
        let of = AttachmentDelivery::of;

        assert_eq!(
            d(PNG_1X1, "a.png", "image/png", true, true),
            of(DeliveryKind::Image)
        );
        assert_eq!(
            d(PNG_1X1, "a.png", "image/png", false, false),
            AttachmentDelivery::unsupported(Some("images for this model".into()))
        );
        assert_eq!(
            d(&pdf, "r.pdf", PDF_MIME, true, true),
            of(DeliveryKind::PdfNative)
        );
        assert_eq!(
            d(&pdf, "r.pdf", PDF_MIME, true, false),
            of(DeliveryKind::Text)
        );
        assert_eq!(
            d(&pdf, "r.pdf", PDF_MIME, false, false),
            of(DeliveryKind::Text)
        );
        assert_eq!(
            d(&docx, "r.docx", DOCX_MIME, true, true),
            of(DeliveryKind::Text)
        );
        assert_eq!(
            d(&csv, "t.csv", "text/csv", false, false),
            of(DeliveryKind::Text)
        );
        assert_eq!(
            d(&xlsx, "budget.xlsx", "application/octet-stream", true, true),
            AttachmentDelivery::unsupported(Some("xlsx files".into()))
        );
        assert_eq!(
            d(b"\0\0\0", "", "application/octet-stream", true, true),
            AttachmentDelivery::unsupported(None)
        );
        // A PDF over the native cap still goes, as text.
        let mut big = pdf.clone();
        big.resize(PDF_FORWARD_MAX_BYTES + 1, b' ');
        assert_eq!(
            d(&big, "big.pdf", PDF_MIME, true, true),
            of(DeliveryKind::Text)
        );
    }

    #[test]
    fn delivery_serialises_as_the_renderer_contract() {
        let json = serde_json::to_value(AttachmentDelivery::of(DeliveryKind::PdfNative)).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "pdf_native" }));
        let json = serde_json::to_value(AttachmentDelivery::unsupported(Some("xlsx files".into())))
            .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "unsupported", "reason": "xlsx files" })
        );
    }

    #[test]
    fn renders_text_with_its_size_and_escapes_the_name() {
        let mut budget = REQUEST_TEXT_MAX_CHARS;
        let text = DocumentText::Text {
            text: "hello".into(),
            total_chars: 5,
        };
        let out = render_attachment(
            "a \"b\" <c>.md",
            DocumentKind::Text(TextFlavor::Markdown),
            &text,
            &mut budget,
        );
        assert_eq!(
            out,
            "<attachment name=\"a &quot;b&quot; &lt;c&gt;.md\" kind=\"md\" chars=\"5\" truncated=\"false\">\nhello\n</attachment>"
        );
        assert_eq!(budget, REQUEST_TEXT_MAX_CHARS - 5);
    }

    #[test]
    fn the_request_budget_truncates_later_attachments() {
        let mut budget = 3;
        let text = DocumentText::Text {
            text: "abcdef".into(),
            total_chars: 6,
        };
        let out = render_attachment(
            "x.txt",
            DocumentKind::Text(TextFlavor::Plain),
            &text,
            &mut budget,
        );
        assert!(out.contains("truncated=\"true\""), "{out}");
        assert!(out.contains("\nabc\n"), "{out}");
        assert!(out.contains("this request's limit"), "{out}");
        assert_eq!(budget, 0);
        let out = render_attachment(
            "y.txt",
            DocumentKind::Text(TextFlavor::Plain),
            &text,
            &mut budget,
        );
        assert!(!out.contains("abc"), "{out}");
        assert!(out.contains("0 of 6 characters"), "{out}");
    }

    #[test]
    fn renders_scans_and_failures_as_errors() {
        let mut budget = 10;
        assert_eq!(
            render_attachment("scan.pdf", DocumentKind::Pdf, &DocumentText::NoTextLayer, &mut budget),
            "<attachment name=\"scan.pdf\" kind=\"pdf\" error=\"no text layer\">This PDF has no text layer (a scan); this model cannot read it.</attachment>"
        );
        assert_eq!(
            render_attachment("bad.docx", DocumentKind::Docx, &DocumentText::Unreadable, &mut budget),
            "<attachment name=\"bad.docx\" kind=\"docx\" error=\"could not read\">This file could not be read.</attachment>"
        );
        assert_eq!(budget, 10);
    }

    #[tokio::test]
    async fn extraction_is_capped_and_cached_by_attachment_id() {
        let id = "attachment-documents-cache-test";
        let long = "x".repeat(DOCUMENT_TEXT_MAX_CHARS + 10);
        let first =
            document_text(id, long.into_bytes(), DocumentKind::Text(TextFlavor::Plain)).await;
        let DocumentText::Text { text, total_chars } = &first else {
            panic!("{first:?}");
        };
        assert_eq!(text.chars().count(), DOCUMENT_TEXT_MAX_CHARS);
        assert_eq!(*total_chars, DOCUMENT_TEXT_MAX_CHARS + 10);
        // Same id, different bytes: the cached extraction answers.
        let second =
            document_text(id, b"other".to_vec(), DocumentKind::Text(TextFlavor::Plain)).await;
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn extracts_pdf_docx_and_reports_scans() {
        let pdf = document_text(
            "ad-pdf",
            tiny_pdf(Some("Quarterly revenue rose")),
            DocumentKind::Pdf,
        )
        .await;
        assert!(
            matches!(&pdf, DocumentText::Text { text, .. } if text.contains("Quarterly revenue rose")),
            "{pdf:?}"
        );
        let docx = document_text(
            "ad-docx",
            tiny_docx(&["First", "Second"]),
            DocumentKind::Docx,
        )
        .await;
        assert!(
            matches!(&docx, DocumentText::Text { text, .. } if text.contains("First") && text.contains("Second")),
            "{docx:?}"
        );
        let scan = document_text("ad-scan", tiny_pdf(None), DocumentKind::Pdf).await;
        assert_eq!(scan, DocumentText::NoTextLayer);
        let broken = document_text(
            "ad-broken",
            b"%PDF-1.4\nnot really".to_vec(),
            DocumentKind::Pdf,
        )
        .await;
        assert_eq!(broken, DocumentText::Unreadable);
    }

    #[test]
    fn the_cache_evicts_the_least_recently_used() {
        let mut cache = ExtractionCache {
            entries: VecDeque::new(),
        };
        for i in 0..EXTRACTION_CACHE_ENTRIES {
            cache.insert(format!("id-{i}"), DocumentText::Unreadable);
        }
        // Touch id-0 so id-1 is now the oldest.
        assert!(cache.get("id-0").is_some());
        cache.insert("new".into(), DocumentText::NoTextLayer);
        assert!(cache.get("id-1").is_none());
        assert!(cache.get("id-0").is_some());
        assert_eq!(cache.entries.len(), EXTRACTION_CACHE_ENTRIES);
    }
}
