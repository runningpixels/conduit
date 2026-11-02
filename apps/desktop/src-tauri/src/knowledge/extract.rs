//! Document text extraction for the local knowledge base (t1-6 M6).
//!
//! [`extract_document`] turns a file on disk into indexable plain text;
//! [`extract_document_bytes`] does the same for a document already in memory
//! (a chat attachment, or a workspace file `workspace_read` sniffed).
//! Dispatch is by lowercased extension: `txt|md|markdown|mdown|text` (read as
//! UTF-8, lossy), `csv`, `docx`, `xlsx`, `pdf`. Anything else is
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
    Xlsx,
    Pdf,
    Html,
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
    let format = format_for_extension(&extension)?;

    // Mitigation 2: the actual parse runs off the async runtime, bounded by
    // a timeout, so a pathological file can only ever stall this one call.
    let path_owned: PathBuf = path.to_path_buf();
    run_parse(move || {
        let bytes =
            std::fs::read(&path_owned).map_err(|e| ExtractFailure::Unreadable(e.to_string()))?;
        parse_sync(&bytes, format)
    })
    .await
}

/// Extracts plain text from a document already in memory: a chat attachment
/// (decrypted out of the blob store, so there is no plaintext file on disk to
/// hand [`extract_document`]) or a workspace file whose bytes were sniffed.
///
/// `extension` picks the parser exactly as a file name's extension would
/// (`pdf`, `docx`, `csv`, `txt`, `md`, …); callers that sniffed the bytes
/// pass the extension of the format they found, not the one the file
/// claimed. Every mitigation [`extract_document`] applies applies here too:
/// the size cap (on the buffer instead of a stat), the off-runtime parse with
/// a timeout, the caught panic, and `NoTextLayer` for an empty result.
pub async fn extract_document_bytes(
    bytes: Vec<u8>,
    extension: &str,
) -> Result<Extracted, ExtractFailure> {
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(ExtractFailure::TooLarge {
            bytes: bytes.len() as u64,
            cap: MAX_DOCUMENT_BYTES,
        });
    }
    let format = format_for_extension(&extension.to_ascii_lowercase())?;
    run_parse(move || parse_sync(&bytes, format)).await
}

fn format_for_extension(extension: &str) -> Result<Format, ExtractFailure> {
    Ok(match extension {
        "txt" | "text" => Format::PlainText { mime: "text/plain" },
        "md" | "markdown" | "mdown" => Format::PlainText {
            mime: "text/markdown",
        },
        "csv" => Format::Csv,
        "docx" => Format::Docx,
        "xlsx" => Format::Xlsx,
        "pdf" => Format::Pdf,
        "html" | "htm" => Format::Html,
        other => return Err(ExtractFailure::UnsupportedFormat(other.to_string())),
    })
}

/// Mitigations 2–4 around one blocking parse: off the runtime, under
/// [`EXTRACT_TIMEOUT`], panics caught, and an empty result is `NoTextLayer`.
async fn run_parse<F>(parse: F) -> Result<Extracted, ExtractFailure>
where
    F: FnOnce() -> Result<Extracted, ExtractFailure> + Send + 'static,
{
    let join_result = tokio::time::timeout(
        EXTRACT_TIMEOUT,
        tokio::task::spawn_blocking(move || parse_blocking(parse)),
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
fn parse_blocking<F>(parse: F) -> Result<Extracted, ExtractFailure>
where
    F: FnOnce() -> Result<Extracted, ExtractFailure>,
{
    match std::panic::catch_unwind(AssertUnwindSafe(parse)) {
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

/// Every parser works on the whole document in memory: the size cap has
/// already bounded it, and one code path serves both files on disk and
/// attachments decrypted out of the blob store.
fn parse_sync(bytes: &[u8], format: Format) -> Result<Extracted, ExtractFailure> {
    match format {
        Format::PlainText { mime } => extract_plain_text(bytes, mime),
        Format::Csv => extract_csv(bytes),
        Format::Docx => extract_docx(bytes),
        Format::Xlsx => extract_xlsx(bytes),
        Format::Pdf => extract_pdf(bytes),
        Format::Html => extract_html(bytes),
    }
}

/// The page's text without its markup, scripts or styles: raw tags would
/// spend the context on `<div class=…>` and bury what the page says.
fn extract_html(bytes: &[u8]) -> Result<Extracted, ExtractFailure> {
    let html = String::from_utf8_lossy(bytes);
    Ok(Extracted {
        text: crate::workflows::extract::extract_document(&html),
        mime_type: Some("text/html".to_string()),
    })
}

fn extract_plain_text(bytes: &[u8], mime: &str) -> Result<Extracted, ExtractFailure> {
    let text = String::from_utf8_lossy(bytes).into_owned();
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
fn extract_csv(bytes: &[u8]) -> Result<Extracted, ExtractFailure> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(bytes);

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
fn extract_docx(bytes: &[u8]) -> Result<Extracted, ExtractFailure> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
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
                let decoded = e.decode().map_err(|err| {
                    ExtractFailure::Unreadable(format!("word/document.xml text decode: {err}"))
                })?;
                out.push_str(&decoded);
            }
            // quick-xml reports `&amp;` / `&#233;` as their own events, not
            // inside the text around them.
            Ok(Event::GeneralRef(e)) if in_text => {
                let unreadable = |err: String| {
                    ExtractFailure::Unreadable(format!("word/document.xml entity decode: {err}"))
                };
                if let Some(ch) = e
                    .resolve_char_ref()
                    .map_err(|err| unreadable(err.to_string()))?
                {
                    out.push(ch);
                } else {
                    let name = e.decode().map_err(|err| unreadable(err.to_string()))?;
                    let resolved = quick_xml::escape::resolve_predefined_entity(&name)
                        .ok_or_else(|| unreadable(format!("unknown entity &{name};")))?;
                    out.push_str(resolved);
                }
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

/// Most uncompressed bytes an xlsx archive may declare across all its entries.
/// Checked from the central directory before anything is inflated; the shared
/// strings part is held in memory whole, so this bounds that too.
pub const XLSX_MAX_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
/// Most entries an xlsx archive may hold (a real workbook has one per sheet
/// plus a dozen parts).
pub const XLSX_MAX_ENTRIES: usize = 2_000;
/// Most uncompressed:compressed ratio, applied once the archive declares more
/// than 1 MiB. Spreadsheet XML compresses 10-50x; bombs go to 1000x and up.
pub const XLSX_MAX_RATIO: u64 = 200;
/// Most rows of one sheet written out (counted from the first used row).
pub const XLSX_MAX_ROWS_PER_SHEET: u32 = 5_000;
/// Most columns of one sheet written out (counted from the first used column).
pub const XLSX_MAX_COLS: u32 = 100;
/// Most characters of text one workbook produces, all sheets together. Equal to
/// the per-document text a chat request carries
/// ([`crate::attachment_documents::DOCUMENT_TEXT_MAX_CHARS`]), so the model is
/// told what was left out instead of it being cut mid-row silently.
pub const XLSX_MAX_TOTAL_CHARS: usize = crate::attachment_documents::DOCUMENT_TEXT_MAX_CHARS;
/// Most non-empty cells held in memory for one sheet while it streams.
const XLSX_MAX_STORED_CELLS: usize = 500_000;

/// The limits of an xlsx zip, from its central directory alone (nothing is
/// inflated). A bomb can lie in the directory, but the zip reader never
/// yields more than an entry declares, so the declared total bounds the read.
fn check_xlsx_zip_limits(bytes: &[u8]) -> Result<(), ExtractFailure> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| ExtractFailure::Unreadable(format!("not a valid xlsx/zip archive: {e}")))?;
    if archive.len() > XLSX_MAX_ENTRIES {
        return Err(ExtractFailure::Unreadable(format!(
            "xlsx archive has {} entries, over the {XLSX_MAX_ENTRIES} entry limit",
            archive.len()
        )));
    }
    let (mut total, mut compressed) = (0u64, 0u64);
    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|e| ExtractFailure::Unreadable(format!("xlsx archive entry {i}: {e}")))?;
        total = total.saturating_add(entry.size());
        compressed = compressed.saturating_add(entry.compressed_size());
    }
    if total > XLSX_MAX_UNCOMPRESSED_BYTES {
        return Err(ExtractFailure::TooLarge {
            bytes: total,
            cap: XLSX_MAX_UNCOMPRESSED_BYTES,
        });
    }
    if total > 1024 * 1024 && total / compressed.max(1) > XLSX_MAX_RATIO {
        return Err(ExtractFailure::Unreadable(format!(
            "xlsx archive inflates {}x, over the {XLSX_MAX_RATIO}x limit (decompression bomb?)",
            total / compressed.max(1)
        )));
    }
    Ok(())
}

/// A workbook as text: per sheet a `## Sheet: <name>` heading (`(hidden)` for
/// hidden sheets), then the sheet's used range as CSV. Values are the ones
/// the file cached; nothing is calculated, so a formula whose result was
/// never saved reads as an empty cell. Dates are ISO (`2024-03-05`, or with a
/// time `2024-03-05T14:30:00`), numbers carry at most 15 significant digits.
///
/// The sheet is streamed cell by cell (calamine's dense `Range` would
/// allocate rows x columns for a lone cell at `XFD1048576`), only
/// [`XLSX_MAX_ROWS_PER_SHEET`] x [`XLSX_MAX_COLS`] from the first used cell
/// are kept, and output stops at [`XLSX_MAX_TOTAL_CHARS`]. Each cut says so.
fn extract_xlsx(bytes: &[u8]) -> Result<Extracted, ExtractFailure> {
    use calamine::{Reader, SheetType, SheetVisible, Xlsx};

    check_xlsx_zip_limits(bytes)?;
    let mut workbook: Xlsx<_> = Xlsx::new(std::io::Cursor::new(bytes))
        .map_err(|e| ExtractFailure::Unreadable(format!("xlsx: {e}")))?;
    let sheets = workbook.sheets_metadata().to_vec();

    let mut out = String::new();
    let mut chars = 0usize;
    for (index, sheet) in sheets.iter().enumerate() {
        if sheet.typ != SheetType::WorkSheet {
            continue;
        }
        let name = sheet.name.replace(['\r', '\n'], " ");
        let hidden = if sheet.visible == SheetVisible::Visible {
            ""
        } else {
            " (hidden)"
        };
        let heading = format!("## Sheet: {name}{hidden}\n");
        if chars + heading.chars().count() > XLSX_MAX_TOTAL_CHARS {
            let left = sheets[index..]
                .iter()
                .filter(|s| s.typ == SheetType::WorkSheet)
                .count();
            out.push_str(&format!(
                "(truncated: {left} more sheets not shown, text limit reached)\n"
            ));
            break;
        }
        chars += heading.chars().count();
        out.push_str(&heading);

        let grid = read_xlsx_sheet(&mut workbook, &sheet.name)?;
        let Some(grid) = grid else {
            out.push_str("(empty)\n\n");
            chars += 9;
            continue;
        };

        let last_row = grid.max_row.min(grid.min_row + XLSX_MAX_ROWS_PER_SHEET - 1);
        let last_col = grid.max_col.min(grid.min_col + XLSX_MAX_COLS - 1);
        let more_cols = grid.max_col - last_col;
        let mut stopped_at: Option<u32> = None;
        for row in grid.min_row..=last_row {
            let line = csv_line(grid.rows.get(&row), grid.min_col, last_col);
            let line_chars = line.chars().count() + 1;
            if chars + line_chars > XLSX_MAX_TOTAL_CHARS {
                stopped_at = Some(row);
                break;
            }
            chars += line_chars;
            out.push_str(&line);
            out.push('\n');
        }
        let rows_left = match stopped_at {
            Some(row) => grid.max_row - row + 1,
            None => grid.max_row - last_row,
        };
        if rows_left > 0 {
            out.push_str(&format!("(truncated: {rows_left} more rows)\n"));
        }
        if more_cols > 0 {
            out.push_str(&format!("(truncated: {more_cols} more columns)\n"));
        }
        if grid.dropped_cells {
            out.push_str("(truncated: this sheet has more cells than are read)\n");
        }
        out.push('\n');
        if stopped_at.is_some() {
            let left = sheets[index + 1..]
                .iter()
                .filter(|s| s.typ == SheetType::WorkSheet)
                .count();
            if left > 0 {
                out.push_str(&format!(
                    "(truncated: {left} more sheets not shown, text limit reached)\n"
                ));
            }
            break;
        }
    }

    Ok(Extracted {
        text: out.trim_end().to_string(),
        mime_type: Some(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
        ),
    })
}

/// The non-empty cells of one sheet, kept sparse.
struct SheetGrid {
    rows: std::collections::BTreeMap<u32, std::collections::BTreeMap<u32, String>>,
    min_row: u32,
    max_row: u32,
    min_col: u32,
    max_col: u32,
    dropped_cells: bool,
}

/// Streams a sheet's cells. `None` when it holds no value at all.
fn read_xlsx_sheet<RS: std::io::Read + std::io::Seek>(
    workbook: &mut calamine::Xlsx<RS>,
    name: &str,
) -> Result<Option<SheetGrid>, ExtractFailure> {
    let unreadable =
        |e: calamine::XlsxError| ExtractFailure::Unreadable(format!("xlsx sheet: {e}"));
    let mut reader = workbook.worksheet_cells_reader(name).map_err(unreadable)?;
    let mut grid = SheetGrid {
        rows: Default::default(),
        min_row: u32::MAX,
        max_row: 0,
        min_col: u32::MAX,
        max_col: 0,
        dropped_cells: false,
    };
    let mut stored = 0usize;
    while let Some(cell) = reader.next_cell().map_err(unreadable)? {
        let (row, col) = cell.get_position();
        let text = xlsx_cell_text(cell.get_value());
        if text.is_empty() {
            continue;
        }
        grid.min_row = grid.min_row.min(row);
        grid.max_row = grid.max_row.max(row);
        grid.min_col = grid.min_col.min(col);
        grid.max_col = grid.max_col.max(col);
        let new_row = !grid.rows.contains_key(&row);
        if stored >= XLSX_MAX_STORED_CELLS
            || (new_row && grid.rows.len() >= XLSX_MAX_ROWS_PER_SHEET as usize)
        {
            // Rows past the row cap are only counted (max_row), not kept.
            grid.dropped_cells |= stored >= XLSX_MAX_STORED_CELLS;
            continue;
        }
        grid.rows.entry(row).or_default().insert(col, text);
        stored += 1;
    }
    Ok((grid.max_row >= grid.min_row).then_some(grid))
}

/// One row of cells `first_col..=last_col` as a CSV line (no newline).
fn csv_line(
    cells: Option<&std::collections::BTreeMap<u32, String>>,
    first_col: u32,
    last_col: u32,
) -> String {
    // Each row stops at its own last value, so one wide row does not pad the
    // thousands of narrow ones with commas.
    let Some(cells) = cells else {
        return String::new();
    };
    let Some(row_last) = cells
        .keys()
        .copied()
        .filter(|&k| k >= first_col && k <= last_col)
        .max()
    else {
        return String::new();
    };
    let fields: Vec<&str> = (first_col..=row_last)
        .map(|c| cells.get(&c).map_or("", String::as_str))
        .collect();
    let mut writer = csv::WriterBuilder::new()
        .terminator(csv::Terminator::Any(b'\n'))
        .from_writer(Vec::new());
    // Writing to a Vec cannot fail.
    let _ = writer.write_record(&fields);
    let bytes = writer.into_inner().unwrap_or_default();
    String::from_utf8_lossy(&bytes)
        .trim_end_matches('\n')
        .to_string()
}

/// One cell's cached value as text; empty for no value.
fn xlsx_cell_text(value: &calamine::DataRef<'_>) -> String {
    use calamine::DataRef;
    match value {
        DataRef::Empty => String::new(),
        DataRef::Int(i) => i.to_string(),
        DataRef::Float(f) => format_xlsx_float(*f),
        DataRef::String(s) => s.clone(),
        DataRef::SharedString(s) => (*s).to_string(),
        DataRef::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        DataRef::DateTime(dt) => format_xlsx_datetime(dt),
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => s.clone(),
        DataRef::Error(e) => e.to_string(),
    }
}

/// A number with at most 15 significant digits (what Excel shows), so
/// `0.1 + 0.2` reads `0.3` rather than `0.30000000000000004`.
fn format_xlsx_float(f: f64) -> String {
    if !f.is_finite() {
        return f.to_string();
    }
    if f.fract() == 0.0 && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    // Round through scientific notation with 15 significant digits.
    let rounded: f64 = format!("{f:.14e}").parse().unwrap_or(f);
    if rounded.abs() >= 1e15 || (rounded != 0.0 && rounded.abs() < 1e-6) {
        format!("{rounded:e}")
    } else {
        format!("{rounded}")
    }
}

/// `2024-03-05`, `2024-03-05T14:30:00`, a bare time `14:30:00` (serial under
/// one day) or a duration `36:15:00`.
fn format_xlsx_datetime(dt: &calamine::ExcelDateTime) -> String {
    let serial = dt.as_f64();
    if dt.is_duration() {
        let secs = (serial * 86_400.0).round() as i64;
        return format!("{}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60);
    }
    // Milliseconds are dropped (truncated, never rounded across midnight).
    let (y, mo, d, h, mi, s, _ms) = dt.to_ymd_hms_milli();
    if (0.0..1.0).contains(&serial) {
        return format!("{h:02}:{mi:02}:{s:02}");
    }
    if (h, mi, s) == (0, 0, 0) {
        format!("{y:04}-{mo:02}-{d:02}")
    } else {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
    }
}

/// `pdf-extract`'s column/row ordering is frequently wrong for tabular PDFs
/// (it has no layout/table model — it emits glyphs roughly in the order the
/// PDF's content stream draws them). This is a known, accepted limitation
/// recorded in the t1-6 plan, not something this function works around.
fn extract_pdf(bytes: &[u8]) -> Result<Extracted, ExtractFailure> {
    let text = pdf_extract::extract_text_from_mem(bytes)
        .map_err(|e| ExtractFailure::Unreadable(format!("pdf: {e}")))?;
    Ok(Extracted {
        text,
        mime_type: Some("application/pdf".to_string()),
    })
}
