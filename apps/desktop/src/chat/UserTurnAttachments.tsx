import { useEffect, useState } from 'react';
import { getAttachmentBytes } from '../ipc/client';
import { FilePlainIcon } from '../icons';
import { isForwardableImageMime, type TurnAttachment } from './composerTypes';
import { useT } from '../i18n';

interface UserTurnAttachmentsProps {
  attachments: TurnAttachment[];
}

/** Short type label for a file chip: the extension, else the MIME subtype. */
export function attachmentTypeLabel(att: TurnAttachment): string {
  const name = att.fileName ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1 && name.length - dot <= 6) {
    return name.slice(dot + 1).toUpperCase();
  }
  const sub = (att.mimeType || '').split('/')[1]?.split(/[+;]/)[0];
  return sub ? sub.toUpperCase().slice(0, 8) : '';
}

/** Thumbnails for image attachments, compact file chips for everything else. */
export function UserTurnAttachments({ attachments }: UserTurnAttachmentsProps) {
  const t = useT();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [broken, setBroken] = useState<Record<string, true>>({});

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const att of attachments) {
        if (!isForwardableImageMime(att.mimeType)) continue;
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
    <div className="turn-attachments" aria-label={t('chat.attachments.ariaLabel')}>
      {attachments.map((att) => {
        if (!isForwardableImageMime(att.mimeType) || broken[att.id]) {
          const type = attachmentTypeLabel(att);
          return (
            <div
              key={att.id}
              className="turn-attachment-file"
              data-testid="turn-attachment-file"
              title={att.fileName}
            >
              <FilePlainIcon />
              <span className="turn-attachment-file-name">
                {att.fileName ?? t('chat.attachments.altFallback')}
              </span>
              {type && <span className="turn-attachment-file-meta">{type}</span>}
            </div>
          );
        }
        return urls[att.id] ? (
          <img
            key={att.id}
            className="turn-attachment-thumb"
            src={urls[att.id]}
            alt={att.fileName ?? t('chat.attachments.altFallback')}
            onError={() => setBroken((prev) => ({ ...prev, [att.id]: true }))}
          />
        ) : (
          <div key={att.id} className="turn-attachment-thumb turn-attachment-placeholder">
            {t('chat.attachments.imagePlaceholder')}
          </div>
        );
      })}
    </div>
  );
}
