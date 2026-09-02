//! Hydrate attachment references into in-memory Image parts for provider send (t0-1).
//!
//! Persistence keeps `AttachmentReference` rows only. Immediately before
//! `adapter.stream_chat`, clone the request and expand image refs to
//! `MessagePartKind::Image` with base64 in `content`. Never write those bytes
//! back to SQLite or onto the long-lived agent-loop request.

use std::path::Path;

use base64::Engine;
use provider_core::model_accepts_images;
use provider_core::schema::{MessagePart, MessagePartKind, MessageRole, ProviderRequest};
use sqlx::SqlitePool;
use tracing::warn;

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
    pub forwarded: usize,
    pub skipped: usize,
    pub text_only_model: bool,
}

/// Clone `request` and replace user attachment refs with hydrated Image parts.
///
/// Skips (does not fail the turn) when:
/// - the model is text-only per [`model_accepts_images`]
/// - MIME is not jpeg/png/webp (after sniff)
/// - decoded size exceeds [`VISION_FORWARD_MAX_BYTES`]
/// - more than [`VISION_FORWARD_MAX_IMAGES`] images (extras skipped)
/// - the blob is missing / unreadable
pub async fn hydrate_request_for_vision(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    provider_id: &str,
    request: &ProviderRequest,
) -> (ProviderRequest, VisionHydrateReport) {
    let mut hydrated = request.clone();
    let mut report = VisionHydrateReport::default();

    if !model_accepts_images(provider_id, &request.model_id) {
        let had_refs = request.messages.iter().any(|m| {
            m.role == MessageRole::User
                && m.parts.iter().any(|p| {
                    matches!(
                        p.kind,
                        MessagePartKind::AttachmentReference | MessagePartKind::Image
                    ) && p.attachment_id.as_ref().is_some_and(|id| !id.is_empty())
                })
        });
        if had_refs {
            report.text_only_model = true;
            report.skipped += 1;
            warn!(
                provider = %provider_id,
                model = %request.model_id,
                "dropping image attachments — model is treated as text-only"
            );
        }
        for message in &mut hydrated.messages {
            if message.role != MessageRole::User {
                continue;
            }
            message.parts.retain(|p| {
                !matches!(
                    p.kind,
                    MessagePartKind::AttachmentReference
                        | MessagePartKind::Image
                        | MessagePartKind::File
                )
            });
            // Re-index after retain.
            for (i, part) in message.parts.iter_mut().enumerate() {
                part.index = i as u32;
            }
        }
        return (hydrated, report);
    }

    let mut images_included = 0usize;

    for message in &mut hydrated.messages {
        if message.role != MessageRole::User {
            continue;
        }

        let mut next_parts: Vec<MessagePart> = Vec::with_capacity(message.parts.len());
        for part in message.parts.drain(..) {
            let should_try = matches!(
                part.kind,
                MessagePartKind::AttachmentReference | MessagePartKind::Image
            ) && part
                .attachment_id
                .as_ref()
                .is_some_and(|id| !id.trim().is_empty());

            if !should_try {
                // Drop File parts from the provider payload (t1-6 / RAG later).
                if part.kind == MessagePartKind::File {
                    report.skipped += 1;
                    continue;
                }
                next_parts.push(part);
                continue;
            }

            if images_included >= VISION_FORWARD_MAX_IMAGES {
                report.skipped += 1;
                warn!(
                    attachment_id = %part.attachment_id.as_deref().unwrap_or(""),
                    "skipping image — per-request limit reached"
                );
                continue;
            }

            let attachment_id = part.attachment_id.as_deref().unwrap();
            match load_forwardable_image(
                pool,
                attachments_dir,
                enc,
                attachment_id,
                part.mime_type.as_deref(),
            )
            .await
            {
                Ok(Some((mime, b64))) => {
                    let mut image_part = part;
                    image_part.kind = MessagePartKind::Image;
                    image_part.mime_type = Some(mime);
                    image_part.content = Some(b64);
                    image_part.blob_ref = None;
                    next_parts.push(image_part);
                    images_included += 1;
                    report.forwarded += 1;
                }
                Ok(None) => {
                    report.skipped += 1;
                }
                Err(err) => {
                    report.skipped += 1;
                    warn!(
                        attachment_id = %attachment_id,
                        error = %err,
                        "skipping image attachment"
                    );
                }
            }
        }

        for (i, part) in next_parts.iter_mut().enumerate() {
            part.index = i as u32;
        }
        message.parts = next_parts;
    }

    (hydrated, report)
}

async fn load_forwardable_image(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    attachment_id: &str,
    claimed_mime: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let Some(att) = attachments::get(pool, attachment_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };

    let bytes =
        attachments::read_bytes(attachments_dir, enc, &att.path).map_err(|e| e.to_string())?;
    if bytes.len() > VISION_FORWARD_MAX_BYTES {
        warn!(
            attachment_id = %attachment_id,
            size = bytes.len(),
            "skipping image — exceeds forward size cap"
        );
        return Ok(None);
    }

    let mime = resolve_image_mime(&bytes, claimed_mime.or(Some(att.mime_type.as_str())));
    let Some(mime) = mime else {
        warn!(
            attachment_id = %attachment_id,
            claimed = %claimed_mime.unwrap_or(&att.mime_type),
            "skipping attachment — not a forwardable image MIME"
        );
        return Ok(None);
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some((mime, b64)))
}

fn resolve_image_mime(bytes: &[u8], claimed: Option<&str>) -> Option<String> {
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
    ALLOWED_MIMES.iter().any(|allowed| *allowed == mime)
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
