import type { Attachment } from '../ipc/contracts';

/** Shared cap for composer textarea growth (px). Keep in sync with CSS `--composer-max-height`. */
export const COMPOSER_MAX_HEIGHT_PX = 180;

/** Inline IPC attachment cap (25 MiB) — mirrors Rust `ATTACHMENT_INLINE_CAP_BYTES`. */
export const ATTACHMENT_INLINE_CAP_BYTES = 25 * 1024 * 1024;

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
