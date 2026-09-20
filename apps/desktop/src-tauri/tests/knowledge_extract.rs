//! Integration tests for `knowledge::extract` (t1-6 M6).
//!
//! Every fixture is built programmatically into a `tempfile::TempDir` — no
//! binary fixtures are checked in.

use std::{
    fs,
    io::Write,
    time::{Duration, Instant},
};

use conduit_desktop::knowledge::extract::{extract_document, ExtractFailure, MAX_DOCUMENT_BYTES};

#[tokio::test]
async fn txt_round_trips_multibyte_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.txt");
    let content = "Hello 世界 🎉 — caf\u{e9}";
    fs::write(&path, content).unwrap();

    let extracted = extract_document(&path).await.expect("txt extracts");
    assert_eq!(extracted.text, content);
    assert_eq!(extracted.mime_type.as_deref(), Some("text/plain"));
}

#[tokio::test]
async fn md_round_trips_multibyte_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("readme.md");
    let content = "# 見出し\n\nSome text with an emoji 🚀 and *markdown*.";
    fs::write(&path, content).unwrap();

    let extracted = extract_document(&path).await.expect("md extracts");
    assert_eq!(extracted.text, content);
    assert_eq!(extracted.mime_type.as_deref(), Some("text/markdown"));
}

#[tokio::test]
async fn csv_preserves_quoted_comma_and_quoted_newline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.csv");

    let mut wtr = csv::WriterBuilder::new().from_writer(Vec::new());
    wtr.write_record(["name", "note"]).unwrap();
    wtr.write_record(["Smith, John", "plain"]).unwrap();
    wtr.write_record(["Multi", "Line1\nLine2"]).unwrap();
    wtr.flush().unwrap();
    let bytes = wtr.into_inner().unwrap();
    fs::write(&path, bytes).unwrap();

    let extracted = extract_document(&path).await.expect("csv extracts");
    assert!(
        extracted.text.contains("Smith, John"),
        "comma inside a quoted field must survive as one field: {}",
        extracted.text
    );
    assert!(
        extracted.text.contains("Multi | Line1\nLine2"),
        "newline inside a quoted field must survive within its own record: {}",
        extracted.text
    );
    assert!(
        extracted.text.starts_with("name | note"),
        "header row must be kept: {}",
        extracted.text
    );
    assert_eq!(extracted.mime_type.as_deref(), Some("text/csv"));
}

/// Builds a minimal docx (a zip archive) in memory. `document_xml = None`
/// omits `word/document.xml` entirely, to exercise the missing-entry path.
fn build_docx(document_xml: Option<&str>) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        match document_xml {
            Some(xml) => {
                zip.start_file("word/document.xml", options).unwrap();
                zip.write_all(xml.as_bytes()).unwrap();
            }
            None => {
                zip.start_file("word/other.xml", options).unwrap();
                zip.write_all(b"<x/>").unwrap();
            }
        }
        zip.finish().unwrap();
    }
    buf
}

#[tokio::test]
async fn docx_decodes_entities_and_separates_paragraphs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("doc.docx");
    let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Salt &amp; pepper</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
</w:body>
</w:document>"#;
    fs::write(&path, build_docx(Some(xml))).unwrap();

    let extracted = extract_document(&path).await.expect("docx extracts");
    assert_eq!(extracted.text, "Salt & pepper\nSecond paragraph");
    assert_eq!(
        extracted.mime_type.as_deref(),
        Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    );
}

#[tokio::test]
async fn docx_missing_document_xml_is_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.docx");
    fs::write(&path, build_docx(None)).unwrap();

    let err = extract_document(&path)
        .await
        .expect_err("archive without word/document.xml must fail");
    assert!(
        matches!(err, ExtractFailure::Unreadable(_)),
        "expected Unreadable, got {err:?}"
    );
}

#[tokio::test]
async fn oversized_file_fails_fast_without_reading_it_all() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("huge.txt");
    let file = fs::File::create(&path).unwrap();
    let oversized = MAX_DOCUMENT_BYTES * 2;
    file.set_len(oversized).unwrap(); // sparse: no content actually written
    drop(file);

    let start = Instant::now();
    let err = extract_document(&path)
        .await
        .expect_err("oversized file must be rejected");
    let elapsed = start.elapsed();

    match err {
        ExtractFailure::TooLarge { bytes, cap } => {
            assert_eq!(bytes, oversized);
            assert_eq!(cap, MAX_DOCUMENT_BYTES);
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
    assert!(
        elapsed < Duration::from_secs(2),
        "the size check must reject via stat() alone, before opening/reading the file: {elapsed:?}"
    );
}

#[tokio::test]
async fn garbage_pdf_bytes_are_unreadable_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.pdf");
    fs::write(
        &path,
        b"this is not a pdf, just garbage bytes \x00\x01\x02\xff\xfe",
    )
    .unwrap();

    let err = extract_document(&path)
        .await
        .expect_err("garbage bytes must not parse as a PDF");
    assert!(
        matches!(err, ExtractFailure::Unreadable(_)),
        "expected Unreadable, got {err:?}"
    );
}

#[tokio::test]
async fn unsupported_extension_carries_the_extension() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archive.zip");
    fs::write(&path, b"whatever").unwrap();

    let err = extract_document(&path)
        .await
        .expect_err("unsupported format must be rejected");
    match err {
        ExtractFailure::UnsupportedFormat(ext) => assert_eq!(ext, "zip"),
        other => panic!("expected UnsupportedFormat, got {other:?}"),
    }
}
