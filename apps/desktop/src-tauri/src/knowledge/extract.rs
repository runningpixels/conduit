//! Document text extraction for the local knowledge base (t1-6 M6).
//!
//! [`extract_document`] turns a file on disk into indexable plain text.
//! Dispatch is by lowercased extension: `txt|md|markdown|mdown|text` (read as
//! UTF-8, lossy), `csv`, `docx`, `pdf`. Anything else is
//! [`ExtractFailure::UnsupportedFormat`].
//!
//! Safe Rust prevents memory corruption, **not** resource exhaustion — a
//! malformed or hostile file can still allocate unboundedly, loop forever, or
//! panic a parser. This module carries five mitigations against that, all
//! required for the milestone to close (see the t1-6 plan):
//!
//! 1. **Size cap before parsing.** [`MAX_DOCUMENT_BYTES`] is checked against
//!    the file's *stat*'d size before anything is opened or read, so an
//!    oversized file is rejected without reading a byte of it. docx is a zip
//!    archive, so its on-disk size says nothing about what it decompresses
//!    to; [`extract_docx`] bounds the decompressed `word/document.xml` read
//!    to the same cap independently, via a `Read::take` on the (streaming,
//!    decompress-on-read) zip entry, so a small archive that would explode
//!    into gigabytes on inflate is still cut off at the cap rather than
//!    exhausting memory.
//! 2. **Off the async runtime, with a timeout.** The blocking parse runs
//!    inside `tokio::task::spawn_blocking`, and the whole call is wrapped in
//!    `tokio::time::timeout(EXTRACT_TIMEOUT, ..)`. A pathological file stalls
//!    one import, never the app; a timeout maps to
//!    [`ExtractFailure::TimedOut`].
//! 3. **Panics at the parse boundary are caught.** `pdf-extract` is known to
//!    panic on some malformed input (not hypothetical — observed upstream).
//!    The blocking closure runs under `std::panic::catch_unwind`
//!    (`AssertUnwindSafe`, since none of the parse functions hold anything
//!    that isn't safely unwind-observable — they're pure read-and-return), so
//!    a panic there is reported as [`ExtractFailure::Unreadable`] instead of
//!    taking down the process.
//! 4. **`NoTextLayer` vs. a parse error.** A scanned PDF (or an empty
//!    document) parses *successfully* and yields nothing useful. After a
//!    successful parse, `extract_document` checks the result: if the text is
//!    empty or all whitespace once trimmed, that's
//!    [`ExtractFailure::NoTextLayer`], not `Unreadable` — the user-facing
//!    message for "this is a scanned image" is different from "this file is
//!    corrupt", and `NoTextLayer` is the case people actually hit.
//! 5. Output is untrusted text, faithfully returned. This module does not
//!    strip or "sanitise" it — the reinjection gate at the retrieval seam is
//!    the caller's job, not this one's.

use std::{
    io::Read,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    time::Duration,
};

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use thiserror::Error;

/// Hard cap on the bytes this module will read for a single document.
/// Checked against the file's stat'd size *before* any parsing begins (the
/// decompression-bomb guard for the simple formats), and again against the
/// decompressed `word/document.xml` payload for docx, since a zip archive's
/// on-disk size is not a bound on what it inflates to.
pub const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

/// How long a single blocking parse gets before `extract_document` gives up
/// on it. A pathological file must stall one import, never the whole app.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);

/// Why [`extract_document`] could not produce text.
#[derive(Debug, Error)]
pub enum ExtractFailure {
    /// The document parsed without error but contained no usable text (e.g.
    /// a scanned PDF with no embedded text layer, or a file that's just
    /// whitespace). Distinct from a parse error: this is not corruption, and
    /// the user-facing message is different.
    #[error("document has no extractable text (no text layer, or empty)")]
    NoTextLayer,
    /// The file's stat'd size (or, for docx, its decompressed
    /// `word/document.xml`) exceeded [`MAX_DOCUMENT_BYTES`].
    #[error("document is {bytes} byte(s), over the {cap} byte cap")]
    TooLarge { bytes: u64, cap: u64 },
    /// The file could not be opened, was not valid for its format, or its
    /// parser panicked.
    #[error("could not read document: {0}")]
    Unreadable(String),
    /// Parsing did not finish within [`EXTRACT_TIMEOUT`].
    #[error("document extraction timed out")]
    TimedOut,
    /// The extension (lowercased) is not one this module handles.
    #[error("unsupported document format: .{0}")]
    UnsupportedFormat(String),
}

/// Extracted plain text, plus a best-effort MIME type for the source format.
#[derive(Debug)]
pub struct Extracted {
    pub text: String,
    pub mime_type: Option<String>,
}

/// Which parser handles the file, decided purely from the lowercased
/// extension. Carried into the blocking task rather than re-deriving it
/// there, so the extension-to-parser mapping lives in exactly one place.
#[derive(Clone, Copy)]
enum Format {
    PlainText { mime: &'static str },
    Csv,
    Docx,
    Pdf,
}

/// Extracts indexable plain text from a file on disk.
///
/// Dispatches on `path`'s lowercased extension. See the module doc comment
/// for the five resource-exhaustion / robustness mitigations this applies.
pub async fn extract_document(path: &Path) -> Result<Extracted, ExtractFailure> {
    // Mitigation 1: stat before opening. A file we refuse never gets read.
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| ExtractFailure::Unreadable(format!("could not stat file: {e}")))?;
    let byte_size = metadata.len();
    if byte_size > MAX_DOCUMENT_BYTES {
        return Err(ExtractFailure::TooLarge {
            bytes: byte_size,
            cap: MAX_DOCUMENT_BYTES,
        });
    }

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    let format = match extension.as_str() {
        "txt" | "text" => Format::PlainText { mime: "text/plain" },
        "md" | "markdown" | "mdown" => Format::PlainText {
            mime: "text/markdown",
        },
        "csv" => Format::Csv,
        "docx" => Format::Docx,
        "pdf" => Format::Pdf,
        other => return Err(ExtractFailure::UnsupportedFormat(other.to_string())),
    };

    // Mitigation 2: the actual parse runs off the async runtime, bounded by
    // a timeout, so a pathological file can only ever stall this one call.
    let path_owned: PathBuf = path.to_path_buf();
    let join_result = tokio::time::timeout(
        EXTRACT_TIMEOUT,
        tokio::task::spawn_blocking(move || parse_blocking(&path_owned, format)),
    )
    .await
    .map_err(|_elapsed| ExtractFailure::TimedOut)?;

    let extracted = join_result.map_err(|join_err| {
        // spawn_blocking itself only errors on cancellation/panic escaping
        // catch_unwind (it shouldn't, given mitigation 3, but this is the
        // defensive fallback rather than unwrapping).
        ExtractFailure::Unreadable(format!("extraction task did not complete: {join_err}"))
    })??;

    // Mitigation 4: a clean parse that yields nothing (or only whitespace)
    // is NoTextLayer, not success and not a parse error.
    if extracted.text.trim().is_empty() {
        return Err(ExtractFailure::NoTextLayer);
    }

    Ok(extracted)
}

/// Runs the format-specific parser under `catch_unwind` (mitigation 3).
/// Everything below this point is synchronous, blocking work — must only be
/// called from inside `spawn_blocking`.
fn parse_blocking(path: &Path, format: Format) -> Result<Extracted, ExtractFailure> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| parse_sync(path, format))) {
        Ok(result) => result,
        Err(panic) => Err(ExtractFailure::Unreadable(format!(
            "extraction panicked: {}",
            panic_message(&panic)
        ))),
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

fn parse_sync(path: &Path, format: Format) -> Result<Extracted, ExtractFailure> {
    match format {
        Format::PlainText { mime } => extract_plain_text(path, mime),
        Format::Csv => extract_csv(path),
        Format::Docx => extract_docx(path),
        Format::Pdf => extract_pdf(path),
    }
}

fn extract_plain_text(path: &Path, mime: &str) -> Result<Extracted, ExtractFailure> {
    let bytes = std::fs::read(path).map_err(|e| ExtractFailure::Unreadable(e.to_string()))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(Extracted {
        text,
        mime_type: Some(mime.to_string()),
    })
}

/// Each CSV record is rendered as its fields joined by `" | "`, one record
/// per line, so a row (including embedded commas/newlines inside quoted
/// fields — the `csv` crate handles those correctly, a hand `split(',')`
/// does not) stays a single coherent retrieval unit. The header row is kept
/// (`has_headers(false)`, so it comes through `records()` like any other
/// row) — it's what makes a bare cell value meaningful.
fn extract_csv(path: &Path) -> Result<Extracted, ExtractFailure> {
    let file = std::fs::File::open(path).map_err(|e| ExtractFailure::Unreadable(e.to_string()))?;
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(file);

    let mut lines: Vec<String> = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| ExtractFailure::Unreadable(format!("csv: {e}")))?;
        let joined = record.iter().collect::<Vec<_>>().join(" | ");
        lines.push(joined);
    }

    Ok(Extracted {
        text: lines.join("\n"),
        mime_type: Some("text/csv".to_string()),
    })
}

/// docx is a zip archive; `word/document.xml` holds the body. Read with
/// `quick-xml` (not a regex — a regex mishandles entities: a document
/// containing `&amp;` would be indexed with visible `&amp;` markup and then
/// fail to match a search for the literal `&` the user actually wrote).
/// `<w:p>` (paragraph) boundaries become newlines so paragraphs don't run
/// together; only text inside `<w:t>` is collected.
fn extract_docx(path: &Path) -> Result<Extracted, ExtractFailure> {
    let file = std::fs::File::open(path).map_err(|e| ExtractFailure::Unreadable(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| ExtractFailure::Unreadable(format!("not a valid docx/zip archive: {e}")))?;
    let mut entry = archive.by_name("word/document.xml").map_err(|_| {
        ExtractFailure::Unreadable("docx archive has no word/document.xml".to_string())
    })?;

    // Mitigation 1 (docx-specific half): bound the number of bytes actually
    // decompressed off the entry's stream, independent of whatever size the
    // zip's central directory claims -- a bomb can lie about that. `take`
    // caps what `read_to_end` will pull through the deflate decoder itself.
    let mut buf = Vec::new();
    let mut limited = (&mut entry).take(MAX_DOCUMENT_BYTES + 1);
    limited
        .read_to_end(&mut buf)
        .map_err(|e| ExtractFailure::Unreadable(format!("word/document.xml: {e}")))?;
    if buf.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(ExtractFailure::TooLarge {
            bytes: buf.len() as u64,
            cap: MAX_DOCUMENT_BYTES,
        });
    }

    let xml = String::from_utf8_lossy(&buf);
    let text = extract_text_from_docx_xml(&xml)?;
    Ok(Extracted {
        text,
        mime_type: Some(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
        ),
    })
}

fn extract_text_from_docx_xml(xml: &str) -> Result<String, ExtractFailure> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out = String::new();
    let mut in_text = false;
    let mut wrote_any_paragraph = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => {
                return Err(ExtractFailure::Unreadable(format!(
                    "word/document.xml: {e}"
                )))
            }
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"p" => {
                if wrote_any_paragraph {
                    out.push('\n');
                }
                wrote_any_paragraph = true;
            }
            Ok(Event::Empty(e)) if e.local_name().as_ref() == b"p" => {
                if wrote_any_paragraph {
                    out.push('\n');
                }
                wrote_any_paragraph = true;
            }
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"t" => {
                in_text = true;
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == b"t" => {
                in_text = false;
            }
            Ok(Event::Text(e)) if in_text => {
                let decoded = e.unescape().map_err(|err| {
                    ExtractFailure::Unreadable(format!("word/document.xml entity decode: {err}"))
                })?;
                out.push_str(&decoded);
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

/// `pdf-extract`'s column/row ordering is frequently wrong for tabular PDFs
/// (it has no layout/table model — it emits glyphs roughly in the order the
/// PDF's content stream draws them). This is a known, accepted limitation
/// recorded in the t1-6 plan, not something this function works around.
fn extract_pdf(path: &Path) -> Result<Extracted, ExtractFailure> {
    let text = pdf_extract::extract_text(path)
        .map_err(|e| ExtractFailure::Unreadable(format!("pdf: {e}")))?;
    Ok(Extracted {
        text,
        mime_type: Some("application/pdf".to_string()),
    })
}
