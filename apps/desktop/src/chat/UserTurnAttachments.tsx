import { useEffect, useState } from 'react';
import { getAttachmentBytes } from '../ipc/client';
import type { TurnAttachment } from './composerTypes';

interface UserTurnAttachmentsProps {
  attachments: TurnAttachment[];
}

/** Thumbnail strip for image attachments on a user bubble. */
export function UserTurnAttachments({ attachments }: UserTurnAttachmentsProps) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const att of attachments) {
        try {
          const bytes = await getAttachmentBytes(att.id);
          const blob = new Blob([new Uint8Array(bytes)], {
            type: att.mimeType || 'application/octet-stream',
          });
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          next[att.id] = url;
        } catch {
          /* missing blob — skip thumbnail */
        }
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [attachments]);

  if (attachments.length === 0) return null;

  return (
    <div className="turn-attachments" aria-label="Attached images">
      {attachments.map((att) =>
        urls[att.id] ? (
          <img
            key={att.id}
            className="turn-attachment-thumb"
            src={urls[att.id]}
            alt={att.fileName ?? 'Attached image'}
          />
        ) : (
          <div key={att.id} className="turn-attachment-thumb turn-attachment-placeholder">
            Image
          </div>
        ),
      )}
    </div>
  );
}
