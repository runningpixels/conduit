//! Hydrate attachment references for provider send (t0-1, documents in chat).
//!
//! Persistence keeps `AttachmentReference` rows only. Immediately before
//! `adapter.stream_chat`, clone the request and expand each reference into
//! what this model can take: an image becomes `MessagePartKind::Image` with
//! base64 in `content`; a PDF for a model that reads PDFs becomes
//! `MessagePartKind::File` with base64 in `content` and the file name in
//! `metadata.filename`; every other document (PDF, DOCX, txt/md/csv) becomes a
//! text part holding its extracted text in an `<attachment …>` element,
//! prepended to that user message (see `attachment_documents`). Never write
//! those bytes back to SQLite or onto the long-lived agent-loop request.

use std::path::Path;

use base64::Engine;
use provider_core::model_accepts_images;
use provider_core::schema::{MessagePart, MessagePartKind, MessageRole, ProviderRequest};
use sqlx::SqlitePool;
use tracing::warn;

use crate::attachment_documents::{
    document_text, render_attachment, sniff_document, DocumentKind, PDF_FORWARD_MAX_BYTES,
    PDF_MIME, REQUEST_TEXT_MAX_CHARS,
};
use crate::db::repository::attachments;
use crate::encryption::Encryption;

/// Decoded image size forwarded to providers (stricter than the 25 MiB store cap).
pub const VISION_FORWARD_MAX_BYTES: usize = 20 * 1024 * 1024;
/// Max images included on a single provider request.
pub const VISION_FORWARD_MAX_IMAGES: usize = 16;

const ALLOWED_MIMES: &[&str] = &["image/jpeg", "image/png", "image/webp"];

/// Result of hydrating a request for one provider round.
#[derive(Debug, Default)]
pub struct VisionHydrateReport {
    /// Images sent as images.
    pub forwarded: usize,
    /// PDFs sent as documents (`File` parts).
    pub documents_native: usize,
    /// Documents sent as extracted text (including scan / failure notes).
    pub documents_as_text: usize,
    pub skipped: usize,
    /// At least one image was dropped because the model is text-only.
    pub text_only_model: bool,
}

/// Clone `request` and replace user attachment refs with what the model takes.
///
/// `pdf_native` is whether this model reads a PDF sent as a document
/// (`provider_core::model_accepts_pdf`, or for OpenRouter its own catalogue;
/// see `AppState::model_accepts_pdf`). The caller decides it because only the
/// app state knows the OpenRouter listing.
///
/// The checks run in the order `attachment_documents::decide_delivery` uses,
/// so the composer's chip says what happens here: PDF/DOCX by signature, then
/// images, then plain text. Skips (does not fail the turn) when:
/// - an image reaches a model that is text-only per [`model_accepts_images`]
/// - an image is over [`VISION_FORWARD_MAX_BYTES`], or past
///   [`VISION_FORWARD_MAX_IMAGES`] in this request
/// - the file is neither an image nor a document this app reads
/// - the blob is missing / unreadable
///
/// A document whose text cannot be extracted (a scan the model cannot read
/// natively, a corrupt file) is not skipped: the model gets an `<attachment>`
/// element saying so, so it can tell the user instead of acting as if nothing
/// was attached.
pub async fn hydrate_request_for_vision(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    provider_id: &str,
    pdf_native: bool,
    request: &ProviderRequest,
) -> (ProviderRequest, VisionHydrateReport) {
    let mut hydrated = request.clone();
    let mut report = VisionHydrateReport::default();
    let images_ok = model_accepts_images(provider_id, &request.model_id);
    let mut images_included = 0usize;
    // Characters of document text still allowed in this request, spent in
    // message order, so the earliest attachments keep their text.
    let mut text_budget = REQUEST_TEXT_MAX_CHARS;

    for message in &mut hydrated.messages {
        if message.role != MessageRole::User {
            continue;
        }

        let mut document_parts: Vec<MessagePart> = Vec::new();
        let mut next_parts: Vec<MessagePart> = Vec::with_capacity(message.parts.len());
        for part in message.parts.drain(..) {
            let attachment_id = part
                .attachment_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            let is_attachment = matches!(
                part.kind,
                MessagePartKind::AttachmentReference
                    | MessagePartKind::Image
                    | MessagePartKind::File
            );

            let Some(attachment_id) = attachment_id.filter(|_| is_attachment) else {
                // An unhydrated File part with nothing to load is dropped, and
                // so is an inline image for a model that cannot see it.
                if part.kind == MessagePartKind::File
                    || (part.kind == MessagePartKind::Image && !images_ok)
                    || part.kind == MessagePartKind::AttachmentReference
                {
                    report.skipped += 1;
                    if part.kind == MessagePartKind::Image {
                        report.text_only_model = true;
                    }
                    continue;
                }
                next_parts.push(part);
                continue;
            };

            let (att, bytes) =
                match load_attachment(pool, attachments_dir, enc, &attachment_id).await {
                    Ok(Some(loaded)) => loaded,
                    Ok(None) => {
                        report.skipped += 1;
                        continue;
                    }
                    Err(err) => {
                        report.skipped += 1;
                        warn!(attachment_id = %attachment_id, error = %err, "skipping attachment");
                        continue;
                    }
                };
            let claimed_mime = part
                .mime_type
                .clone()
                .unwrap_or_else(|| att.mime_type.clone());
            let filename = att.origin.clone();
            let document = sniff_document(&bytes, filename.as_deref(), Some(&claimed_mime));

            // 1. A PDF the model reads natively goes as the PDF.
            if document == Some(DocumentKind::Pdf)
                && pdf_native
                && bytes.len() <= PDF_FORWARD_MAX_BYTES
            {
                let mut file_part = part;
                file_part.kind = MessagePartKind::File;
                file_part.mime_type = Some(PDF_MIME.to_string());
                file_part.content = Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
                file_part.blob_ref = None;
                file_part.metadata = Some(serde_json::json!({
                    "filename": filename.as_deref().unwrap_or("document.pdf"),
                }));
                next_parts.push(file_part);
                report.documents_native += 1;
                continue;
            }

            // 2. Images (unless the bytes are a PDF/DOCX whatever was claimed).
            let signed_document = matches!(document, Some(DocumentKind::Pdf | DocumentKind::Docx));
            if !signed_document {
                if let Some(mime) = resolve_image_mime(&bytes, Some(&claimed_mime)) {
                    if !images_ok {
                        report.text_only_model = true;
                        report.skipped += 1;
                        continue;
                    }
                    if images_included >= VISION_FORWARD_MAX_IMAGES {
                        report.skipped += 1;
                        warn!(
                            attachment_id = %attachment_id,
                            "skipping image — per-request limit reached"
                        );
                        continue;
                    }
                    if bytes.len() > VISION_FORWARD_MAX_BYTES {
                        report.skipped += 1;
                        warn!(
                            attachment_id = %attachment_id,
                            size = bytes.len(),
                            "skipping image — exceeds forward size cap"
                        );
                        continue;
                    }
                    let mut image_part = part;
                    image_part.kind = MessagePartKind::Image;
                    image_part.mime_type = Some(mime);
                    image_part.content =
                        Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
                    image_part.blob_ref = None;
                    next_parts.push(image_part);
                    images_included += 1;
                    report.forwarded += 1;
                    continue;
                }
            }

            // 3. Any other document goes as its extracted text.
            let Some(kind) = document else {
                report.skipped += 1;
                warn!(
                    attachment_id = %attachment_id,
                    claimed = %claimed_mime,
                    "skipping attachment — neither an image nor a readable document"
                );
                continue;
            };
            let text = document_text(&attachment_id, bytes, kind).await;
            let name = filename
                .clone()
                .unwrap_or_else(|| format!("attachment.{}", kind.extension()));
            let block = render_attachment(&name, kind, &text, &mut text_budget);
            document_parts.push(MessagePart {
                id: format!("{}-text", part.id),
                message_id: part.message_id.clone(),
                index: 0,
                kind: MessagePartKind::Text,
                content: Some(block),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: part.created_at.clone(),
            });
            report.documents_as_text += 1;
        }

        // Documents read as text come first, so the question that follows
        // them reads as being about them.
        document_parts.extend(next_parts);
        for (i, part) in document_parts.iter_mut().enumerate() {
            part.index = i as u32;
        }
        message.parts = document_parts;
    }

    (hydrated, report)
}

async fn load_attachment(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    attachment_id: &str,
) -> Result<Option<(attachments::Attachment, Vec<u8>)>, String> {
    let Some(att) = attachments::get(pool, attachment_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let bytes =
        attachments::read_bytes(attachments_dir, enc, &att.path).map_err(|e| e.to_string())?;
    Ok(Some((att, bytes)))
}

/// The forwardable image MIME of `bytes`: sniffed first, else the claimed
/// type when it is one of jpeg/png/webp. `None` for anything else.
pub(crate) fn resolve_image_mime(bytes: &[u8], claimed: Option<&str>) -> Option<String> {
    if let Some(kind) = infer::get(bytes) {
        let mime = kind.mime_type();
        if is_allowed_mime(mime) {
            return Some(normalize_mime(mime));
        }
    }
    let claimed = claimed?.trim().to_ascii_lowercase();
    let claimed = if claimed == "image/jpg" {
        "image/jpeg".to_string()
    } else {
        claimed
    };
    if is_allowed_mime(&claimed) {
        Some(claimed)
    } else {
        None
    }
}

fn is_allowed_mime(mime: &str) -> bool {
    ALLOWED_MIMES.contains(&mime)
}

fn normalize_mime(mime: &str) -> String {
    if mime.eq_ignore_ascii_case("image/jpg") {
        "image/jpeg".to_string()
    } else {
        mime.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_png() {
        // 1x1 PNG
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        assert_eq!(
            resolve_image_mime(png, Some("application/octet-stream")).as_deref(),
            Some("image/png")
        );
    }

    #[test]
    fn rejects_non_image() {
        assert!(resolve_image_mime(b"not an image", Some("text/plain")).is_none());
    }
}
