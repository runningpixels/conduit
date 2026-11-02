//! Integration tests for the xlsx half of `knowledge::extract`.
//!
//! One real workbook is checked in (`fixtures/xlsx/sample.xlsx`); the limit
//! tests build theirs programmatically.

use std::io::Write;

use conduit_desktop::knowledge::extract::{
    extract_document_bytes, ExtractFailure, MAX_DOCUMENT_BYTES, XLSX_MAX_COLS, XLSX_MAX_ENTRIES,
    XLSX_MAX_ROWS_PER_SHEET, XLSX_MAX_TOTAL_CHARS, XLSX_MAX_UNCOMPRESSED_BYTES,
};

/// `tests/fixtures/xlsx/sample.xlsx`, made by `make_sample.py` in that folder
/// (openpyxl). Sheet "Budget": a header row; a string with a comma; a string
/// with quotes; a date; a date with a time; a multi-line string; 0.1 + 0.2 as
/// stored (`0.30000000000000004`); a boolean; `=B2+B3` with its cached result
/// 1244.5 injected by the script's second pass; `=B2*2` with NO cached value
/// (openpyxl writes none, and the script leaves it that way on purpose, so
/// the test also covers "a formula without a cached value reads empty"); and
/// two styled-but-empty cells (C12, H20) that must not stretch the range.
/// Sheet "Secret" is hidden; sheet "Blank" holds nothing.
const SAMPLE_XLSX: &[u8] = include_bytes!("fixtures/xlsx/sample.xlsx");

#[tokio::test]
async fn xlsx_fixture_becomes_csv_per_sheet() {
    let extracted = extract_document_bytes(SAMPLE_XLSX.to_vec(), "xlsx")
        .await
        .expect("xlsx extracts");
    let expected = "\
## Sheet: Budget
Item,Amount,Note,Date
\"Widgets, large\",1234.5,\"He said \"\"hi\"\"\",2024-03-05
Gadgets,10,\"line one
line two\",2024-03-06T14:30:00
Float noise,0.3,TRUE
Total,1244.5
Uncached

## Sheet: Secret (hidden)
code,value
alpha,1

## Sheet: Blank
(empty)";
    assert_eq!(extracted.text, expected);
    assert_eq!(
        extracted.mime_type.as_deref(),
        Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    );
}

/// A tiny workbook: one sheet "Data" whose `<sheetData>` is `sheet_data`.
/// Numbers are written inline and text as `inlineStr`, so there is no
/// shared-strings part.
fn build_xlsx(sheet_data: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let parts: [(&str, String); 4] = [
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string(),
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_string(),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_string(),
            ),
            (
                "xl/worksheets/sheet1.xml",
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_data}</sheetData></worksheet>"#
                ),
            ),
        ];
        for (name, body) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

/// Zero-based column index to letters (0 -> A, 26 -> AA).
fn col_name(index: u32) -> String {
    let mut n = index + 1;
    let mut name = String::new();
    while n > 0 {
        name.insert(0, (b'A' + ((n - 1) % 26) as u8) as char);
        n = (n - 1) / 26;
    }
    name
}

fn num_cell(row: u32, col: u32, value: u32) -> String {
    format!(r#"<c r="{}{}"><v>{value}</v></c>"#, col_name(col), row + 1)
}

fn text_cell(row: u32, col: u32, text: &str) -> String {
    format!(
        r#"<c r="{}{}" t="inlineStr"><is><t>{text}</t></is></c>"#,
        col_name(col),
        row + 1
    )
}

#[tokio::test]
async fn xlsx_lone_far_cell_does_not_allocate_the_whole_grid() {
    // A cell at XFD1048576 must not allocate a dense 17-billion-cell range.
    let rows = format!(
        r#"<row r="3">{}{}</row><row r="1048576">{}</row>"#,
        num_cell(2, 2, 7),
        text_cell(2, 3, "x"),
        num_cell(1_048_575, 16_383, 9),
    );
    let text = extract_document_bytes(build_xlsx(&rows), "xlsx")
        .await
        .expect("sparse sheet extracts")
        .text;
    assert!(text.starts_with("## Sheet: Data\n7,x\n"), "{text:.200}");
    // Rows 3..=5002 are shown (the cap); the rest, up to the far row, is counted.
    let left = 1_048_576 - (2 + XLSX_MAX_ROWS_PER_SHEET);
    assert!(
        text.contains(&format!("(truncated: {left} more rows)")),
        "{text:.200}"
    );
    assert!(text.contains("more columns)"), "{text:.200}");
}

#[tokio::test]
async fn xlsx_caps_rows_and_columns_and_says_so() {
    let mut rows = String::new();
    // Row 1 is wide (XLSX_MAX_COLS + 3 cells); every other row has one cell.
    let wide: String = (0..(XLSX_MAX_COLS + 3))
        .map(|c| num_cell(0, c, c))
        .collect();
    rows.push_str(&format!(r#"<row r="1">{wide}</row>"#));
    for r in 1..(XLSX_MAX_ROWS_PER_SHEET + 25) {
        rows.push_str(&format!(
            r#"<row r="{}">{}</row>"#,
            r + 1,
            num_cell(r, 0, r)
        ));
    }
    let text = extract_document_bytes(build_xlsx(&rows), "xlsx")
        .await
        .unwrap()
        .text;
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "## Sheet: Data");
    assert_eq!(lines[1].split(',').count(), XLSX_MAX_COLS as usize);
    // heading + the row cap + two notes.
    assert_eq!(lines.len(), 1 + XLSX_MAX_ROWS_PER_SHEET as usize + 2);
    assert_eq!(lines[lines.len() - 2], "(truncated: 25 more rows)");
    assert_eq!(lines[lines.len() - 1], "(truncated: 3 more columns)");
}

#[tokio::test]
async fn xlsx_stops_at_the_total_character_cap() {
    // 40 rows of 4000 characters = 160 000 > 150 000.
    let long = "a".repeat(4_000);
    let rows: String = (0..40)
        .map(|r| format!(r#"<row r="{}">{}</row>"#, r + 1, text_cell(r, 0, &long)))
        .collect();
    let text = extract_document_bytes(build_xlsx(&rows), "xlsx")
        .await
        .unwrap()
        .text;
    assert!(text.chars().count() <= XLSX_MAX_TOTAL_CHARS + 100);
    // Whole rows only: (150000 - 15 heading) / 4001 = 37 fit, 3 are left.
    assert_eq!(text.lines().last().unwrap(), "(truncated: 3 more rows)");
    assert_eq!(text.lines().count(), 1 + 37 + 1);
}

/// A zip with `extra_entries` empty entries, plus (when `uncompressed > 0`) one
/// sheet entry that inflates to that many zero bytes. `level` is the deflate
/// level (1 gives ~100:1 on zeros, 9 gives ~1000:1).
fn zip_of_zeros(extra_entries: usize, uncompressed: u64, level: i64) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(level));
        zip.start_file("xl/workbook.xml", options).unwrap();
        zip.write_all(b"<workbook/>").unwrap();
        for i in 0..extra_entries {
            zip.start_file(format!("xl/e{i}.xml"), options).unwrap();
        }
        if uncompressed > 0 {
            zip.start_file("xl/worksheets/sheet1.xml", options).unwrap();
            let chunk = vec![0u8; 1024 * 1024];
            let mut left = uncompressed;
            while left > 0 {
                let n = left.min(chunk.len() as u64) as usize;
                zip.write_all(&chunk[..n]).unwrap();
                left -= n as u64;
            }
        }
        zip.finish().unwrap();
    }
    buf
}

#[tokio::test]
async fn xlsx_zip_bombs_are_refused_before_parsing() {
    // Ratio: 8 MiB of zeros at deflate level 9 is about 1000:1.
    let err = extract_document_bytes(zip_of_zeros(0, 8 * 1024 * 1024, 9), "xlsx")
        .await
        .expect_err("ratio bomb");
    assert!(
        matches!(&err, ExtractFailure::Unreadable(m) if m.contains("decompression bomb")),
        "{err:?}"
    );

    // Total declared size.
    let big = zip_of_zeros(0, XLSX_MAX_UNCOMPRESSED_BYTES + 1, 9);
    assert!(
        (big.len() as u64) < MAX_DOCUMENT_BYTES,
        "the zip itself is small"
    );
    let err = extract_document_bytes(big, "xlsx")
        .await
        .expect_err("size bomb");
    assert!(
        matches!(err, ExtractFailure::TooLarge { cap, .. } if cap == XLSX_MAX_UNCOMPRESSED_BYTES),
        "{err:?}"
    );

    // Entry count.
    let err = extract_document_bytes(zip_of_zeros(XLSX_MAX_ENTRIES, 0, 1), "xlsx")
        .await
        .expect_err("too many entries");
    assert!(
        matches!(&err, ExtractFailure::Unreadable(m) if m.contains("entries")),
        "{err:?}"
    );
}

#[tokio::test]
async fn xlsx_that_is_not_a_zip_is_unreadable() {
    let err = extract_document_bytes(b"not a zip at all".to_vec(), "xlsx")
        .await
        .expect_err("garbage");
    assert!(matches!(err, ExtractFailure::Unreadable(_)), "{err:?}");
}
