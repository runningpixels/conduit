import type { Attachment } from '../ipc/contracts';

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
}

/** Attachment ref carried on a chat turn / ProviderRequest (no bytes). */
export interface TurnAttachment {
  id: string;
  mimeType: string;
  fileName?: string;
}

export function isForwardableImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.trim().toLowerCase();
  if (FORWARDABLE_IMAGE_MIMES.has(normalized)) return true;
  // Some browsers report `image/jpg`.
  return normalized === 'image/jpg';
}

export function turnAttachmentsFromPending(items: PendingAttachment[]): TurnAttachment[] {
  return items
    .filter((item) => item.status === 'uploaded' && item.attachment?.id)
    .filter((item) => isForwardableImageMime(item.mimeType || item.attachment?.mimeType))
    .map((item) => ({
      id: item.attachment!.id,
      mimeType: (item.mimeType || item.attachment!.mimeType || 'application/octet-stream').toLowerCase(),
      fileName: item.fileName,
    }));
}
