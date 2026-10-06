import type { Attachment, AttachmentDelivery } from '../ipc/contracts';

/** Shared cap for composer textarea growth (px). Keep in sync with CSS `--composer-max-height`. */
export const COMPOSER_MAX_HEIGHT_PX = 180;

/** Inline IPC attachment cap (25 MiB) — mirrors Rust `ATTACHMENT_INLINE_CAP_BYTES`. */
export const ATTACHMENT_INLINE_CAP_BYTES = 25 * 1024 * 1024;

/** MIME types forwarded to vision models (t0-1). Others may still upload for later RAG. */
export const FORWARDABLE_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const COMPOSER_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * What the "+" picker offers: images plus the documents the send path can
 * read (pdf, docx, txt, md, csv). Both the extension and the MIME type are
 * listed because browsers/WebView2 match on either and report neither
 * reliably (a `.md` often has no MIME at all). This is only the picker's
 * filter, not the authority: Rust sniffs the bytes and `attachment_delivery`
 * says what actually happens, so a file picked via "All files" still gets an
 * honest chip.
 */
export const COMPOSER_DOCUMENT_ACCEPT = [
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
].join(',');

export const COMPOSER_ATTACH_ACCEPT = `${COMPOSER_IMAGE_ACCEPT},${COMPOSER_DOCUMENT_ACCEPT}`;

export type PendingAttachmentStatus = 'uploading' | 'uploaded' | 'failed';

export interface PendingAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: PendingAttachmentStatus;
  file?: File;
  attachment?: Attachment;
  error?: string;
  /** What will happen to this file with the active model, as answered by
   *  `attachment_delivery`. Absent until the first answer, or for good when
   *  the query failed (then `deliveryKey` is set and `delivery` stays absent). */
  delivery?: AttachmentDelivery;
  /** The `provider/model` key the answer (or failure) belongs to. The answer
   *  depends on the model (native PDF, vision), so a changed key makes it stale. */
  deliveryKey?: string;
}

/** Attachment ref carried on a chat turn / ProviderRequest (no bytes). */
export interface TurnAttachment {
  id: string;
  mimeType: string;
  fileName?: string;
}

/** A `#`-picked document reference (t1-8 M3, D7/D8). Carried on a chat turn as
 *  a `knowledgeReference` message part; the title/collection name are copied
 *  at pick time so a reference to a since-deleted document still reads right. */
export interface KnowledgeRef {
  documentId: string;
  title: string;
  collectionId: string;
  collectionName: string;
}

export function isForwardableImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.trim().toLowerCase();
  if (FORWARDABLE_IMAGE_MIMES.has(normalized)) return true;
  // Some browsers report `image/jpg`.
  return normalized === 'image/jpg';
}

/** The `provider/model` key a delivery answer is valid for. */
export function deliveryKeyFor(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** What a chip says about an uploaded attachment. `checking` covers both "never
 *  asked" and "asked for another model": nothing is promised while the answer
 *  for the active model is in flight. `unknown` is a failed query on a
 *  non-image, where nothing is promised either. */
export type AttachmentChipState =
  | { kind: 'checking' }
  | { kind: 'image' }
  | { kind: 'pdf' }
  | { kind: 'text' }
  | { kind: 'unsupported'; reason?: string }
  | { kind: 'unknown' };

export function attachmentChipState(item: PendingAttachment, currentKey: string): AttachmentChipState {
  if (item.deliveryKey !== currentKey) return { kind: 'checking' };
  if (!item.delivery) {
    // The query failed: only what the old rule could vouch for.
    return isForwardableImageMime(item.mimeType || item.attachment?.mimeType)
      ? { kind: 'image' }
      : { kind: 'unknown' };
  }
  switch (item.delivery.kind) {
    case 'image':
      return { kind: 'image' };
    case 'pdf_native':
      return { kind: 'pdf' };
    case 'text':
      return { kind: 'text' };
    default:
      return { kind: 'unsupported', reason: item.delivery.reason };
  }
}

/** True while an uploaded attachment's delivery for the active model is not yet
 *  known; sending then would race the answer, so the composer waits. */
export function deliveryPending(items: PendingAttachment[], currentKey: string): boolean {
  return items.some(
    (item) => item.status === 'uploaded' && attachmentChipState(item, currentKey).kind === 'checking',
  );
}

/**
 * The attachments a turn forwards: every uploaded one whose delivery is image,
 * pdf_native or text (never `unsupported`, never a non-image whose delivery
 * could not be determined). Rust hydrates each into an image, a PDF document
 * part or extracted text. Without a key (callers that predate delivery) only
 * images pass, as before.
 */
export function turnAttachmentsFromPending(
  items: PendingAttachment[],
  currentKey?: string,
): TurnAttachment[] {
  return items
    .filter((item) => item.status === 'uploaded' && item.attachment?.id)
    .filter((item) => {
      if (currentKey === undefined) return isForwardableImageMime(item.mimeType || item.attachment?.mimeType);
      const state = attachmentChipState(item, currentKey).kind;
      return state === 'image' || state === 'pdf' || state === 'text';
    })
    .map((item) => ({
      id: item.attachment!.id,
      mimeType: (item.mimeType || item.attachment!.mimeType || 'application/octet-stream').toLowerCase(),
      fileName: item.fileName,
    }));
}
