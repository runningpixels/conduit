//! Documents in chat: `vision::hydrate_request_for_vision` turns each stored
//! attachment into what the model takes — an image, a PDF sent as a document,
//! or the document's extracted text in an `<attachment>` element.

mod common;

use std::io::Write;

use conduit_desktop::attachment_documents::{DOCUMENT_TEXT_MAX_CHARS, DOCX_MIME, PDF_MIME};
use conduit_desktop::db::repository::{attachments, conversations};
use conduit_desktop::encryption::Encryption;
use conduit_desktop::vision::{hydrate_request_for_vision, VisionHydrateReport};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole, ProviderRequest};
use sqlx::SqlitePool;

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// A one-page PDF saying `line`; `None` draws a line and no text (a "scan").
fn tiny_pdf(line: Option<&str>) -> Vec<u8> {
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

fn tiny_docx(paragraphs: &[&str]) -> Vec<u8> {
    let body: String = paragraphs
        .iter()
        .map(|p| format!("<w:p><w:r><w:t>{p}</w:t></w:r></w:p>"))
        .collect();
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
         <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:body>{body}</w:body></w:document>"
    );
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    out.into_inner()
}

struct Fixture {
    pool: SqlitePool,
    enc: Encryption,
    dir: tempfile::TempDir,
    conversation_id: String,
}

impl Fixture {
    async fn new() -> Self {
        let pool = common::setup_pool().await;
        let conv = conversations::create(&pool, None).await.unwrap();
        Self {
            pool,
            enc: common::setup_encryption(),
            dir: tempfile::tempdir().unwrap(),
            conversation_id: conv.id,
        }
    }

    async fn attach(&self, bytes: &[u8], mime: &str, name: &str) -> attachments::Attachment {
        attachments::save(
            &self.pool,
            self.dir.path(),
            &self.enc,
            &self.conversation_id,
            bytes,
            mime,
            Some(name),
        )
        .await
        .unwrap()
    }

    async fn hydrate(
        &self,
        provider: &str,
        model: &str,
        pdf_native: bool,
        request: &ProviderRequest,
    ) -> (ProviderRequest, VisionHydrateReport) {
        hydrate_request_for_vision(
            &self.pool,
            self.dir.path(),
            &self.enc,
            provider,
            pdf_native,
            &ProviderRequest {
                model_id: model.into(),
                ..request.clone()
            },
        )
        .await
    }
}

fn part(message_id: &str, index: u32, kind: MessagePartKind) -> MessagePart {
    MessagePart {
        id: format!("{message_id}-p{index}"),
        message_id: message_id.into(),
        index,
        kind,
        content: None,
        mime_type: None,
        tool_call_id: None,
        artifact_id: None,
        attachment_id: None,
        blob_ref: None,
        metadata: None,
        created_at: "2026-01-01T00:00:00Z".into(),
    }
}

/// One user message per entry: the question, then a reference to each attachment.
fn request(turns: &[(&str, Vec<&attachments::Attachment>)]) -> ProviderRequest {
    let messages = turns
        .iter()
        .enumerate()
        .map(|(i, (question, atts))| {
            let id = format!("m{i}");
            let mut parts = vec![MessagePart {
                content: Some((*question).into()),
                ..part(&id, 0, MessagePartKind::Text)
            }];
            for att in atts {
                parts.push(MessagePart {
                    attachment_id: Some(att.id.clone()),
                    mime_type: Some(att.mime_type.clone()),
                    ..part(
                        &id,
                        parts.len() as u32,
                        MessagePartKind::AttachmentReference,
                    )
                });
            }
            Message {
                id: id.clone(),
                conversation_id: "c".into(),
                role: MessageRole::User,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts,
                created_at: "2026-01-01T00:00:00Z".into(),
            }
        })
        .collect();
    ProviderRequest {
        request_id: "r".into(),
        conversation_id: "c".into(),
        model_id: String::new(),
        messages,
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: vec![],
        generation_controls: None,
        response_format: None,
        web_search: None,
    }
}

fn texts(message: &Message) -> Vec<&str> {
    message
        .parts
        .iter()
        .filter(|p| p.kind == MessagePartKind::Text)
        .filter_map(|p| p.content.as_deref())
        .collect()
}

#[tokio::test]
async fn an_image_is_still_an_image() {
    let f = Fixture::new().await;
    let img = f.attach(PNG_1X1, "image/png", "dot.png").await;
    let (out, report) = f
        .hydrate(
            "anthropic",
            "claude-sonnet-4",
            true,
            &request(&[("what?", vec![&img])]),
        )
        .await;
    let parts = &out.messages[0].parts;
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[1].kind, MessagePartKind::Image);
    assert_eq!(parts[1].mime_type.as_deref(), Some("image/png"));
    assert_eq!(report.forwarded, 1);
}

#[tokio::test]
async fn a_pdf_goes_natively_to_a_model_that_reads_pdfs() {
    let f = Fixture::new().await;
    let pdf = f
        .attach(&tiny_pdf(Some("Native page")), PDF_MIME, "report.pdf")
        .await;
    let (out, report) = f
        .hydrate(
            "anthropic",
            "claude-sonnet-4",
            true,
            &request(&[("sum up", vec![&pdf])]),
        )
        .await;
    let parts = &out.messages[0].parts;
    assert_eq!(parts.len(), 2, "{parts:?}");
    assert_eq!(parts[0].content.as_deref(), Some("sum up"));
    let file = &parts[1];
    assert_eq!(file.kind, MessagePartKind::File);
    assert_eq!(file.mime_type.as_deref(), Some(PDF_MIME));
    assert_eq!(
        file.metadata.as_ref().unwrap()["filename"].as_str(),
        Some("report.pdf")
    );
    assert!(file.content.as_deref().unwrap().starts_with("JVBERi0")); // "%PDF-"
    assert_eq!(report.documents_native, 1);
    assert_eq!(report.documents_as_text, 0);
    // It passes request validation (File parts need an attachment id).
    provider_core::validate(out).expect("valid request");
}

#[tokio::test]
async fn a_pdf_goes_as_text_otherwise_and_comes_first() {
    let f = Fixture::new().await;
    let pdf = f
        .attach(
            &tiny_pdf(Some("Revenue grew nine percent")),
            PDF_MIME,
            "q3.pdf",
        )
        .await;
    let (out, report) = f
        .hydrate(
            "lmstudio",
            "qwen3-8b",
            false,
            &request(&[("what grew?", vec![&pdf])]),
        )
        .await;
    let message = &out.messages[0];
    assert!(message
        .parts
        .iter()
        .all(|p| p.kind == MessagePartKind::Text));
    let t = texts(message);
    assert_eq!(t.len(), 2);
    assert!(
        t[0].starts_with("<attachment name=\"q3.pdf\" kind=\"pdf\" chars=\""),
        "{}",
        t[0]
    );
    assert!(t[0].contains("truncated=\"false\""), "{}", t[0]);
    assert!(t[0].contains("Revenue grew nine percent"), "{}", t[0]);
    assert!(t[0].ends_with("</attachment>"));
    assert_eq!(t[1], "what grew?");
    assert_eq!(report.documents_as_text, 1);
    assert_eq!(message.parts[0].index, 0);
    assert_eq!(message.parts[1].index, 1);
}

#[tokio::test]
async fn docx_and_csv_go_as_text_even_to_a_text_only_model() {
    let f = Fixture::new().await;
    let docx = f
        .attach(&tiny_docx(&["Scope", "Budget"]), DOCX_MIME, "brief.docx")
        .await;
    // A browser reports .csv as an Excel type; the name and bytes decide.
    let csv = f
        .attach(
            b"name,score\nAda,9\n",
            "application/vnd.ms-excel",
            "scores.csv",
        )
        .await;
    let img = f.attach(PNG_1X1, "image/png", "dot.png").await;
    let (out, report) = f
        .hydrate(
            "deepseek",
            "deepseek-v4-pro",
            false,
            &request(&[("compare", vec![&docx, &csv, &img])]),
        )
        .await;
    let t = texts(&out.messages[0]);
    assert_eq!(t.len(), 3, "{t:?}");
    assert!(t[0].contains("kind=\"docx\"") && t[0].contains("Scope") && t[0].contains("Budget"));
    assert!(
        t[1].contains("kind=\"csv\"") && t[1].contains("Ada | 9"),
        "{}",
        t[1]
    );
    assert_eq!(t[2], "compare");
    // The image is dropped: the model is text-only.
    assert!(out.messages[0]
        .parts
        .iter()
        .all(|p| p.kind != MessagePartKind::Image));
    assert!(report.text_only_model);
    assert_eq!(report.documents_as_text, 2);
}

#[tokio::test]
async fn a_scan_the_model_cannot_read_says_so() {
    let f = Fixture::new().await;
    let scan = f.attach(&tiny_pdf(None), PDF_MIME, "scan.pdf").await;
    let (out, _) = f
        .hydrate(
            "openai",
            "gpt-4-turbo",
            false,
            &request(&[("read it", vec![&scan])]),
        )
        .await;
    assert_eq!(
        texts(&out.messages[0])[0],
        "<attachment name=\"scan.pdf\" kind=\"pdf\" error=\"no text layer\">This PDF has no text layer (a scan); this model cannot read it.</attachment>"
    );

    // The same scan reaches a model that reads PDFs as the PDF.
    let (out, _) = f
        .hydrate(
            "openai",
            "gpt-4o",
            true,
            &request(&[("read it", vec![&scan])]),
        )
        .await;
    assert_eq!(out.messages[0].parts[1].kind, MessagePartKind::File);
}

#[tokio::test]
async fn an_unreadable_document_says_so() {
    let f = Fixture::new().await;
    let broken = f
        .attach(
            b"%PDF-1.4\nthis is not really a pdf",
            PDF_MIME,
            "broken.pdf",
        )
        .await;
    let (out, _) = f
        .hydrate(
            "lmstudio",
            "qwen3-8b",
            false,
            &request(&[("?", vec![&broken])]),
        )
        .await;
    assert_eq!(
        texts(&out.messages[0])[0],
        "<attachment name=\"broken.pdf\" kind=\"pdf\" error=\"could not read\">This file could not be read.</attachment>"
    );
}

#[tokio::test]
async fn unsupported_files_are_not_sent() {
    let f = Fixture::new().await;
    let bin = f
        .attach(b"\0\x01\x02binary", "application/octet-stream", "data.bin")
        .await;
    let (out, report) = f
        .hydrate(
            "anthropic",
            "claude-sonnet-4",
            true,
            &request(&[("?", vec![&bin])]),
        )
        .await;
    assert_eq!(texts(&out.messages[0]), vec!["?"]);
    assert_eq!(out.messages[0].parts.len(), 1);
    assert_eq!(report.skipped, 1);
}

#[tokio::test]
async fn the_request_cap_truncates_later_attachments_across_the_history() {
    let f = Fixture::new().await;
    let long = "y".repeat(DOCUMENT_TEXT_MAX_CHARS + 1_000);
    let a = f.attach(long.as_bytes(), "text/plain", "a.txt").await;
    let b = f.attach(long.as_bytes(), "text/plain", "b.txt").await;
    let c = f.attach(long.as_bytes(), "text/plain", "c.txt").await;
    let (out, _) = f
        .hydrate(
            "lmstudio",
            "qwen3-8b",
            false,
            &request(&[("first", vec![&a, &b]), ("later", vec![&c])]),
        )
        .await;
    let first = texts(&out.messages[0]);
    // Each is cut to the per-document cap and says so.
    for block in &first[..2] {
        assert!(block.contains("truncated=\"true\""), "{}", &block[..120]);
        assert!(block.contains("only the first 150000"));
        assert!(block.contains(&format!("chars=\"{}\"", DOCUMENT_TEXT_MAX_CHARS + 1_000)));
    }
    // The 300 000-character budget is spent, so the later one gets only a note.
    let later = texts(&out.messages[1])[0];
    assert!(!later.contains("yyyy"), "{later}");
    assert!(
        later.contains("this request's limit of 300000 characters"),
        "{later}"
    );
}

#[tokio::test]
async fn extraction_is_cached_across_turns() {
    let f = Fixture::new().await;
    let doc = f
        .attach(&tiny_docx(&["Cached words"]), DOCX_MIME, "c.docx")
        .await;
    let req = request(&[("?", vec![&doc])]);
    let (first, _) = f.hydrate("lmstudio", "qwen3-8b", false, &req).await;
    assert!(texts(&first.messages[0])[0].contains("Cached words"));

    // Swap the stored blob for another document (encryption is off, so it is
    // plain on disk): a re-extraction would now read other words; the cached
    // text for this attachment id still answers.
    let blob = attachments::resolve_blob_path(f.dir.path(), &doc.path);
    std::fs::write(&blob, tiny_docx(&["Different words"])).unwrap();
    let (second, _) = f.hydrate("lmstudio", "qwen3-8b", false, &req).await;
    assert_eq!(texts(&second.messages[0])[0], texts(&first.messages[0])[0]);
}
