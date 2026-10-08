//! Data in: the `read_file` and `parse_data` steps.
//!
//! - `read_file` reads one file inside the workflow's own folder and nowhere
//!   else. The path is a relative one; it is refused when it is absolute, goes
//!   up with `..`, or (once symlinks are followed) leads outside the folder.
//!   Text formats are read as text; PDF and DOCX go through the same text
//!   extraction as chat attachments and `workspace_read`.
//! - `parse_data` turns CSV, TSV or JSON text into rows a later step can loop
//!   over or index (`{{steps.d.rows.0.Revenue}}`), plus a markdown table to
//!   hand to a model.

use std::path::{Component, Path};

use serde_json::{json, Map, Value};

use crate::attachment_documents::{sniff_document, DocumentKind};
use crate::knowledge::extract::{extract_document_bytes, ExtractFailure};
use crate::workspace_tools::path_policy;

/// Largest file `read_file` opens.
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Most data rows `parse_data` keeps.
pub const MAX_ROWS: usize = 10_000;
/// Most rows in the markdown `text` of a table.
pub const MAX_TEXT_ROWS: usize = 200;
/// Most individual ragged-row notes in `warnings`.
const MAX_ROW_WARNINGS: usize = 5;
/// What the runner's text cap appends to a long text; `parse_data` drops that
/// line rather than reading it as a row.
const CUT_MARKER: &str = "[\u{2026} cut:";

/// A file read by [`read_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRead {
    /// The relative path, as asked for.
    pub path: String,
    pub name: String,
    pub text: String,
    /// Last modified, RFC 3339 in the user's time zone.
    pub modified: String,
    pub bytes: u64,
}

impl FileRead {
    pub fn into_value(self) -> Value {
        json!({
            "path": self.path,
            "name": self.name,
            "text": self.text,
            "modified": self.modified,
            "bytes": self.bytes,
        })
    }
}

fn looks_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || Path::new(path).is_absolute()
}

/// The path inside the folder to open, or why it can't be: checked before
/// anything touches the disk.
fn checked_relative(path: &str) -> Result<&str, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("The file path came out empty.".to_string());
    }
    if path.contains('\0') {
        return Err("That file path isn't valid.".to_string());
    }
    if looks_absolute(path) {
        return Err(
            "A file path has to be inside the workflow's folder, not a full path.".to_string(),
        );
    }
    let goes_up = path.split(['/', '\\']).any(|part| part == "..")
        || Path::new(path)
            .components()
            .any(|c| matches!(c, Component::ParentDir));
    if goes_up {
        return Err(
            "A file path can't go up out of the workflow's folder (no \"..\").".to_string(),
        );
    }
    Ok(path)
}

/// Read `relative` from inside `folder`.
pub async fn read_file(folder: Option<&str>, relative: &str) -> Result<FileRead, String> {
    let folder = folder
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .ok_or("This workflow has no folder to read files from. Choose one first.")?;
    let relative = checked_relative(relative)?;
    let (folder, relative_owned) = (folder.to_string(), relative.to_string());
    let (name, bytes, modified, size) =
        tokio::task::spawn_blocking(move || load(&folder, &relative_owned))
            .await
            .map_err(|_| "The file could not be read.".to_string())??;

    let text = text_of(&name, bytes).await?;
    Ok(FileRead {
        path: relative.to_string(),
        name,
        text,
        modified,
        bytes: size,
    })
}

/// The blocking half: find the file, check it stays in the folder, read it.
fn load(folder: &str, relative: &str) -> Result<(String, Vec<u8>, String, u64), String> {
    let root = std::fs::canonicalize(folder).map_err(|_| {
        "The workflow's folder can't be opened. Check that it still exists.".to_string()
    })?;
    if !root.is_dir() {
        return Err("The workflow's folder isn't a folder any more.".to_string());
    }
    let target = std::fs::canonicalize(root.join(relative))
        .map_err(|_| format!("There's no file called \"{relative}\" in the folder."))?;
    if !target.starts_with(&root) {
        return Err("That path leads outside the workflow's folder.".to_string());
    }
    // The same list of secrets-looking names the chat's file tools refuse.
    if let Ok(inside) = target.strip_prefix(&root) {
        if path_policy::is_denied(inside) {
            return Err("That file is blocked because it may hold secrets.".to_string());
        }
    }
    let meta = std::fs::metadata(&target).map_err(|e| format!("The file can't be read: {e}"))?;
    if !meta.is_file() {
        return Err(format!("\"{relative}\" isn't a file."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "\"{relative}\" is over the {} MB limit for files.",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("The file can't be read: {e}"))?;
    let modified = meta
        .modified()
        .map(|t| {
            chrono::DateTime::<chrono::Local>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
        })
        .unwrap_or_default();
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((name, bytes, modified, meta.len()))
}

/// The file's text: extracted for a PDF or DOCX, else read as UTF-8.
async fn text_of(name: &str, bytes: Vec<u8>) -> Result<String, String> {
    if let Some(kind @ (DocumentKind::Pdf | DocumentKind::Docx)) =
        sniff_document(&bytes, None, None)
    {
        let label = if kind == DocumentKind::Pdf {
            "PDF"
        } else {
            "Word document"
        };
        return match extract_document_bytes(bytes, kind.extension()).await {
            Ok(extracted) => Ok(extracted.text),
            Err(ExtractFailure::NoTextLayer) if kind == DocumentKind::Pdf => Err(format!(
                "\"{name}\" is a scanned PDF: its pages are pictures, so there's no text to read."
            )),
            Err(ExtractFailure::NoTextLayer) => Err(format!("\"{name}\" has no text in it.")),
            Err(e) => Err(format!("\"{name}\" couldn't be read as a {label}: {e}")),
        };
    }
    if crate::workspace_tools::tools::looks_binary(&bytes) {
        return Err(format!(
            "\"{name}\" isn't a text, PDF or Word file, so it can't be read."
        ));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

// ── parse_data ───────────────────────────────────────────────────────────────

/// Parse `input` as `format` (`csv`, `tsv` or `json`).
pub fn parse_data(input: &str, format: &str) -> Result<Value, String> {
    let mut text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut warnings = Vec::new();
    // A long input is cut by the runner with a marker line; don't read it as data.
    if let Some(at) = text.rfind(CUT_MARKER) {
        if text[at..].trim_end().ends_with(']') && !text[at..].trim_end().contains('\n') {
            text = text[..at].trim_end();
            warnings.push("The data was cut short before it reached this step.".to_string());
        }
    }
    if text.trim().is_empty() {
        return Err("There's no data to read: the input came out empty.".to_string());
    }
    match format {
        "csv" => parse_delimited(text, b',', "CSV", warnings),
        "tsv" => parse_delimited(text, b'\t', "TSV", warnings),
        "json" => parse_json(text, warnings),
        other => Err(format!(
            "\"{other}\" isn't a data format. Use csv, tsv or json."
        )),
    }
}

/// The 1-based line of the first quote that is never closed, if any. A quote
/// only opens a quoted field at the start of one, as in the parser below.
fn unclosed_quote(text: &str, delimiter: u8) -> Option<u64> {
    let (mut line, mut opened_at) = (1u64, 0u64);
    let (mut in_quotes, mut field_start) = (false, true);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                }
                '"' => {
                    in_quotes = false;
                    field_start = false;
                }
                '\n' => line += 1,
                _ => {}
            }
            continue;
        }
        match c {
            '"' if field_start => {
                in_quotes = true;
                opened_at = line;
                field_start = false;
            }
            '\n' => {
                line += 1;
                field_start = true;
            }
            '\r' => field_start = true,
            c if c == delimiter as char => field_start = true,
            _ => field_start = false,
        }
    }
    in_quotes.then_some(opened_at)
}

fn parse_delimited(
    text: &str,
    delimiter: u8,
    label: &str,
    mut warnings: Vec<String>,
) -> Result<Value, String> {
    if let Some(line) = unclosed_quote(text, delimiter) {
        return Err(format!("Line {line} of the {label} has an unclosed quote."));
    }
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());
    let mut records: Vec<(u64, Vec<String>)> = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| match e.position() {
            Some(p) => format!("Line {} of the {label} can't be read.", p.line()),
            None => format!("The {label} can't be read."),
        })?;
        let cells: Vec<String> = record.iter().map(str::to_string).collect();
        // A line of only spaces is an empty line.
        if cells.len() == 1 && cells[0].trim().is_empty() {
            continue;
        }
        let line = record.position().map_or(0, |p| p.line());
        records.push((line, cells));
        if records.len() > MAX_ROWS + 1 {
            return Err(too_many_rows());
        }
    }
    let mut records = records.into_iter();
    let Some((_, header)) = records.next() else {
        return Err("There's no data to read: the input came out empty.".to_string());
    };
    let columns = column_names(&header);
    let mut rows = Vec::new();
    let (mut ragged, mut noted) = (0usize, 0usize);
    for (line, mut cells) in records {
        if cells.len() != columns.len() {
            ragged += 1;
            if noted < MAX_ROW_WARNINGS {
                noted += 1;
                let fix = if cells.len() < columns.len() {
                    "filled in with blanks"
                } else {
                    "extra values left out"
                };
                warnings.push(format!(
                    "Line {line} has {} value{} but the header has {}; {fix}.",
                    cells.len(),
                    if cells.len() == 1 { "" } else { "s" },
                    columns.len()
                ));
            }
            cells.resize(columns.len(), String::new());
        }
        rows.push(cells.into_iter().map(Value::String).collect::<Vec<_>>());
    }
    if ragged > noted {
        warnings.push(format!(
            "{} more rows also had the wrong number of values.",
            ragged - noted
        ));
    }
    Ok(table(columns, rows, warnings))
}

/// The header cells as column names: trimmed, blank ones numbered, repeats
/// told apart (`Region`, `Region (2)`).
fn column_names(header: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (i, cell) in header.iter().enumerate() {
        let base = match cell.trim() {
            "" => format!("Column {}", i + 1),
            name => name.to_string(),
        };
        let mut name = base.clone();
        let mut n = 2;
        while names.contains(&name) {
            name = format!("{base} ({n})");
            n += 1;
        }
        names.push(name);
    }
    names
}

fn too_many_rows() -> String {
    format!(
        "That's more than {} rows. Use a smaller file, or cut it down first.",
        format_thousands(MAX_ROWS)
    )
}

fn format_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn parse_json(text: &str, warnings: Vec<String>) -> Result<Value, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| {
        let message = e.to_string();
        let message = message
            .rfind(" at line ")
            .map_or(message.as_str(), |at| &message[..at]);
        format!("Line {} of the JSON can't be read: {message}.", e.line())
    })?;
    let list = match &value {
        Value::Array(items) => Some(items),
        Value::Object(map) if map.len() == 1 => map.values().next().and_then(Value::as_array),
        _ => None,
    };
    let objects = list.filter(|items| !items.is_empty() && items.iter().all(Value::is_object));
    let Some(items) = objects else {
        let pretty = serde_json::to_string_pretty(&value).unwrap_or_default();
        let mut out = json!({ "data": value, "text": pretty });
        if !warnings.is_empty() {
            out["warnings"] = json!(warnings);
        }
        return Ok(out);
    };
    if items.len() > MAX_ROWS {
        return Err(too_many_rows());
    }
    let mut columns: Vec<String> = Vec::new();
    for item in items {
        if let Some(map) = item.as_object() {
            for key in map.keys() {
                if !columns.contains(key) {
                    columns.push(key.clone());
                }
            }
        }
    }
    // `serde_json::Map` doesn't keep the file's key order unless asked to, so
    // first-seen order comes from the text of each object where it can.
    columns = ordered_like_the_text(text, columns);
    let rows = items
        .iter()
        .map(|item| {
            columns
                .iter()
                .map(|c| Value::String(stringify(item.get(c))))
                .collect::<Vec<_>>()
        })
        .collect();
    Ok(table(columns, rows, warnings))
}

/// `columns` ordered by where each key first appears in `text`, so a table
/// reads left to right as the file does. Keys that can't be found keep their
/// relative order, after the others.
fn ordered_like_the_text(text: &str, columns: Vec<String>) -> Vec<String> {
    let mut positions: Vec<(usize, usize, String)> = columns
        .into_iter()
        .enumerate()
        .map(|(i, key)| {
            let quoted = serde_json::to_string(&key).unwrap_or_default();
            // The key is followed by a colon; a value that equals it isn't.
            let at = text
                .match_indices(&quoted)
                .find(|(end, _)| text[end + quoted.len()..].trim_start().starts_with(':'))
                .map_or(usize::MAX, |(at, _)| at);
            (at, i, key)
        })
        .collect();
    positions.sort_by_key(|(at, i, _)| (*at, *i));
    positions.into_iter().map(|(_, _, key)| key).collect()
}

fn stringify(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// The step's output for rows of strings in column order.
fn table(columns: Vec<String>, rows: Vec<Vec<Value>>, warnings: Vec<String>) -> Value {
    let text = markdown_table(&columns, &rows);
    let count = rows.len();
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|cells| {
            let mut row = Map::new();
            for (column, cell) in columns.iter().zip(cells) {
                row.insert(column.clone(), cell);
            }
            Value::Object(row)
        })
        .collect();
    json!({
        "columns": columns,
        "rows": rows,
        "count": count,
        "text": text,
        "warnings": warnings,
    })
}

fn markdown_table(columns: &[String], rows: &[Vec<Value>]) -> String {
    let cell = |s: &str| s.replace('|', "\\|").replace(['\r', '\n'], " ");
    let line = |cells: Vec<String>| format!("| {} |", cells.join(" | "));
    let mut out = vec![
        line(columns.iter().map(|c| cell(c)).collect()),
        line(columns.iter().map(|_| "---".to_string()).collect()),
    ];
    for row in rows.iter().take(MAX_TEXT_ROWS) {
        out.push(line(
            row.iter()
                .map(|v| cell(v.as_str().unwrap_or_default()))
                .collect(),
        ));
    }
    if rows.len() > MAX_TEXT_ROWS {
        out.push(format!(
            "(\u{2026} {} more rows)",
            rows.len() - MAX_TEXT_ROWS
        ));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachment_documents::test_fixtures::{tiny_docx, tiny_pdf};

    fn parsed(input: &str, format: &str) -> Value {
        parse_data(input, format).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn csv_becomes_columns_rows_and_a_table() {
        let out = parsed("Week,Revenue\n1,100\n2,250\n\n3,300\n", "csv");
        assert_eq!(out["columns"], json!(["Week", "Revenue"]));
        assert_eq!(out["count"], 3);
        assert_eq!(out["rows"][1], json!({ "Week": "2", "Revenue": "250" }));
        assert_eq!(out["warnings"], json!([]));
        assert_eq!(
            out["text"],
            "| Week | Revenue |\n| --- | --- |\n| 1 | 100 |\n| 2 | 250 |\n| 3 | 300 |"
        );
    }

    #[test]
    fn tsv_and_a_byte_order_mark() {
        let out = parsed("\u{feff}Name\tScore\nAda\t9\n", "tsv");
        assert_eq!(out["columns"], json!(["Name", "Score"]));
        assert_eq!(out["rows"][0]["Name"], "Ada");
    }

    #[test]
    fn quoted_fields_keep_commas_quotes_and_newlines() {
        let out = parsed(
            "Name,Note\n\"Smith, Ann\",\"line one\nline two\"\nBob,\"said \"\"hi\"\"\"\n",
            "csv",
        );
        assert_eq!(out["count"], 2);
        assert_eq!(out["rows"][0]["Name"], "Smith, Ann");
        assert_eq!(out["rows"][0]["Note"], "line one\nline two");
        assert_eq!(out["rows"][1]["Note"], "said \"hi\"");
        // A newline or a bar in a cell can't break the markdown table.
        let text = out["text"].as_str().unwrap();
        assert_eq!(text.lines().count(), 4, "{text}");
    }

    #[test]
    fn ragged_rows_are_padded_or_cut_with_a_warning() {
        let out = parsed("a,b,c\n1,2\n1,2,3,4\n5,6,7\n", "csv");
        assert_eq!(out["rows"][0], json!({ "a": "1", "b": "2", "c": "" }));
        assert_eq!(out["rows"][1], json!({ "a": "1", "b": "2", "c": "3" }));
        let warnings = out["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0]
            .as_str()
            .unwrap()
            .starts_with("Line 2 has 2 values"));
        assert!(warnings[1]
            .as_str()
            .unwrap()
            .starts_with("Line 3 has 4 values"));
    }

    #[test]
    fn blank_and_repeated_headers_get_names() {
        let out = parsed("Region,,Region\nN,x,y\n", "csv");
        assert_eq!(out["columns"], json!(["Region", "Column 2", "Region (2)"]));
    }

    #[test]
    fn an_unclosed_quote_names_its_line() {
        let err = parse_data("a,b\n1,2\n3,4\n5,\"oops\n6,7\n", "csv").unwrap_err();
        assert_eq!(err, "Line 4 of the CSV has an unclosed quote.");
        let err = parse_data("a\tb\n\"x\ty\n", "tsv").unwrap_err();
        assert_eq!(err, "Line 2 of the TSV has an unclosed quote.");
        // A quote in the middle of a field is just a character.
        assert!(parse_data("a,b\n5\" pipe,2\n", "csv").is_ok());
    }

    #[test]
    fn the_text_table_stops_at_200_rows_but_the_rows_are_all_there() {
        let mut csv = String::from("n\n");
        for i in 0..250 {
            csv.push_str(&format!("{i}\n"));
        }
        let out = parsed(&csv, "csv");
        assert_eq!(out["count"], 250);
        assert_eq!(out["rows"].as_array().unwrap().len(), 250);
        let text = out["text"].as_str().unwrap();
        assert!(text.ends_with("(\u{2026} 50 more rows)"), "{text}");
        assert_eq!(text.lines().count(), 2 + 200 + 1);
    }

    #[test]
    fn more_than_ten_thousand_rows_is_an_error() {
        let csv = format!("n\n{}", "1\n".repeat(MAX_ROWS + 1));
        let err = parse_data(&csv, "csv").unwrap_err();
        assert!(err.starts_with("That's more than 10,000 rows"), "{err}");
        let ok = format!("n\n{}", "1\n".repeat(MAX_ROWS));
        assert_eq!(parsed(&ok, "csv")["count"], MAX_ROWS);
    }

    #[test]
    fn json_lists_of_objects_become_rows() {
        let out = parsed(
            r#"[{"week": 1, "revenue": 10.5, "ok": true}, {"week": 2, "note": null, "revenue": "n/a"}]"#,
            "json",
        );
        assert_eq!(out["columns"], json!(["week", "revenue", "ok", "note"]));
        assert_eq!(out["count"], 2);
        assert_eq!(
            out["rows"][0],
            json!({ "week": "1", "revenue": "10.5", "ok": "true", "note": "" })
        );
        assert_eq!(out["rows"][1]["revenue"], "n/a");
        assert_eq!(out["rows"][1]["ok"], "");
    }

    #[test]
    fn json_with_one_key_holding_the_list_is_unwrapped() {
        let out = parsed(r#"{"data": [{"a": "x"}, {"a": "y"}]}"#, "json");
        assert_eq!(out["columns"], json!(["a"]));
        assert_eq!(out["count"], 2);
        // Nested values are written out as JSON.
        let nested = parsed(r#"[{"a": {"b": 1}, "c": [1, 2]}]"#, "json");
        assert_eq!(nested["rows"][0]["a"], "{\"b\":1}");
        assert_eq!(nested["rows"][0]["c"], "[1,2]");
    }

    #[test]
    fn json_that_is_not_a_table_comes_back_as_data() {
        for input in [
            r#"{"total": 5, "items": [{"a": 1}]}"#,
            r#"{"a": 1}"#,
            "[1, 2, 3]",
            r#"[{"a": 1}, 2]"#,
            "[]",
            "\"hello\"",
        ] {
            let out = parsed(input, "json");
            assert!(out.get("rows").is_none(), "{input}");
            assert_eq!(out["data"], serde_json::from_str::<Value>(input).unwrap());
            assert!(out["text"].as_str().unwrap().len() >= 2);
        }
        assert!(parsed(r#"{"a": 1}"#, "json")["text"]
            .as_str()
            .unwrap()
            .contains("\n  \"a\": 1\n"));
    }

    #[test]
    fn bad_json_and_empty_input_are_explained() {
        let err = parse_data("{\n  \"a\": 1,\n  \"b\": \n}", "json").unwrap_err();
        assert!(
            err.starts_with("Line 4 of the JSON can't be read: "),
            "{err}"
        );
        assert!(!err.contains(" at line "), "{err}");
        assert!(parse_data("  \n ", "csv").unwrap_err().contains("no data"));
        assert!(parse_data("a,b", "xml")
            .unwrap_err()
            .contains("isn't a data format"));
    }

    #[test]
    fn a_cut_marker_from_a_long_input_is_not_a_row() {
        let input = "a,b\n1,2\n3,4\n[\u{2026} cut: 5000 more characters]";
        let out = parsed(input, "csv");
        assert_eq!(out["count"], 2);
        assert!(out["warnings"][0].as_str().unwrap().contains("cut short"));
    }

    fn folder_with(files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        dir
    }

    async fn read(dir: &tempfile::TempDir, path: &str) -> Result<FileRead, String> {
        read_file(Some(dir.path().to_str().unwrap()), path).await
    }

    #[tokio::test]
    async fn reads_text_csv_and_json_files() {
        let dir = folder_with(&[
            ("notes.txt", b"hello there"),
            ("reports/metrics.csv", b"\xEF\xBB\xBFWeek,Revenue\n1,100\n"),
            ("data.json", b"{\"a\": 1}"),
        ]);
        let notes = read(&dir, "notes.txt").await.unwrap();
        assert_eq!(notes.text, "hello there");
        assert_eq!((notes.name.as_str(), notes.bytes), ("notes.txt", 11));
        assert_eq!(notes.path, "notes.txt");
        assert!(notes.modified.contains('T'), "{}", notes.modified);

        let csv = read(&dir, "reports/metrics.csv").await.unwrap();
        assert_eq!(csv.text, "Week,Revenue\n1,100\n", "the BOM is dropped");
        assert_eq!(csv.name, "metrics.csv");
        // Backslashes and a leading ./ work too.
        assert!(read(&dir, ".\\reports\\metrics.csv").await.is_ok() || cfg!(not(windows)));
        assert_eq!(read(&dir, "data.json").await.unwrap().text, "{\"a\": 1}");
        let value = notes.into_value();
        assert_eq!(value["bytes"], 11);
    }

    #[tokio::test]
    async fn extracts_the_text_of_a_pdf_and_a_docx() {
        let dir = folder_with(&[
            ("brief.pdf", &tiny_pdf(Some("Quarterly numbers"))),
            ("memo.docx", &tiny_docx(&["First paragraph", "Second one"])),
        ]);
        let pdf = read(&dir, "brief.pdf").await.unwrap();
        assert!(pdf.text.contains("Quarterly numbers"), "{:?}", pdf.text);
        let docx = read(&dir, "memo.docx").await.unwrap();
        assert!(docx.text.contains("First paragraph"), "{:?}", docx.text);
        assert!(docx.text.contains("Second one"));
    }

    #[tokio::test]
    async fn a_scan_or_binary_file_is_refused_in_plain_words() {
        let dir = folder_with(&[
            ("scan.pdf", &tiny_pdf(None)),
            ("photo.bin", &[0u8, 1, 2, 3, 0, 0]),
        ]);
        let scan = read(&dir, "scan.pdf").await.unwrap_err();
        assert!(scan.contains("scanned PDF"), "{scan}");
        let bin = read(&dir, "photo.bin").await.unwrap_err();
        assert!(bin.contains("can't be read"), "{bin}");
    }

    #[tokio::test]
    async fn refuses_what_is_not_inside_the_folder() {
        let dir = folder_with(&[("a.txt", b"x"), ("sub/b.txt", b"y")]);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "nope").unwrap();

        let no_folder = read_file(None, "a.txt").await.unwrap_err();
        assert!(no_folder.contains("no folder"), "{no_folder}");
        assert!(read_file(Some("  "), "a.txt").await.is_err());

        let absolute = outside.path().join("secret.txt");
        for path in [
            absolute.to_str().unwrap(),
            "/etc/passwd",
            "\\\\server\\share\\x.txt",
            "C:\\Windows\\win.ini",
        ] {
            let err = read(&dir, path).await.unwrap_err();
            assert!(err.contains("not a full path"), "{path}: {err}");
        }
        for path in ["../secret.txt", "sub/../../x", "sub\\..\\..\\x", ".."] {
            let err = read(&dir, path).await.unwrap_err();
            assert!(err.contains("no \"..\""), "{path}: {err}");
        }
        assert!(read(&dir, "").await.is_err());
        assert!(read(&dir, "missing.txt")
            .await
            .unwrap_err()
            .contains("no file called"));
        assert!(read(&dir, "sub")
            .await
            .unwrap_err()
            .contains("isn't a file"));
        let gone = read_file(Some("/definitely/not/a/folder/here"), "a.txt")
            .await
            .unwrap_err();
        assert!(gone.contains("can't be opened"), "{gone}");
    }

    #[tokio::test]
    async fn the_deny_list_of_secret_names_applies() {
        let dir = folder_with(&[(".env", b"KEY=1"), ("keys/server.pem", b"x")]);
        for path in [".env", "keys/server.pem"] {
            let err = read(&dir, path).await.unwrap_err();
            assert!(err.contains("may hold secrets"), "{path}: {err}");
        }
    }

    #[tokio::test]
    async fn a_symlink_out_of_the_folder_is_refused() {
        let dir = folder_with(&[("a.txt", b"x")]);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        let link = dir.path().join("link.txt");
        let dir_link = dir.path().join("linked");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link)
            .and_then(|()| std::os::unix::fs::symlink(outside.path(), &dir_link));
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(outside.path().join("secret.txt"), &link)
            .and_then(|()| std::os::windows::fs::symlink_dir(outside.path(), &dir_link));
        if made.is_err() {
            // Creating a symlink needs a privilege on some systems.
            eprintln!("skipping: symlinks can't be created here");
            return;
        }
        for path in ["link.txt", "linked/secret.txt"] {
            let err = read(&dir, path).await.unwrap_err();
            assert!(
                err.contains("outside the workflow's folder"),
                "{path}: {err}"
            );
        }
        assert!(read(&dir, "a.txt").await.is_ok());
    }

    #[tokio::test]
    async fn a_file_over_the_limit_is_refused_without_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(dir.path().join("big.csv")).unwrap();
        // Sparse where the file system allows: no 20 MB of real writes.
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        let err = read(&dir, "big.csv").await.unwrap_err();
        assert!(err.contains("over the 20 MB limit"), "{err}");
    }
}
