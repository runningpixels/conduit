/// The files a tool call saved (a browser download the person allowed), one
/// compact card each under the step's row: the name, the size and "Save as…".
/// There is deliberately no "Open": Conduit never opens a downloaded file.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { saveAttachmentAs } from '../ipc/client';
import type { SavedFile } from '../ipc/contracts';
import { FilePlainIcon } from '../icons';
import { rejectionText } from '../workflows/CommandRuleList';

function SavedFileCard({ file }: { file: SavedFile }) {
  const t = useT();
  const fmt = useFormatters();
  const alive = useRef(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setFailed(null);
    try {
      await saveAttachmentAs(file.attachmentId);
    } catch (e) {
      if (alive.current) setFailed(t('chat.toolCall.file.saveFailed', { error: rejectionText(e) }));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  return (
    <div className="saved-file">
      <span className="saved-file-icon" aria-hidden="true">
        <FilePlainIcon />
      </span>
      <span className="saved-file-name" title={file.name}>
        {file.name}
      </span>
      <span className="saved-file-size">{fmt.size(file.size)}</span>
      <button
        type="button"
        className="btn"
        disabled={saving}
        aria-label={t('chat.toolCall.file.saveAria', { name: file.name })}
        onClick={() => void save()}
      >
        {t('chat.toolCall.file.save')}
      </button>
      {failed ? (
        <p className="wf-error saved-file-error" role="alert">
          {failed}
        </p>
      ) : null}
    </div>
  );
}

export function SavedFileCards({ files }: { files: SavedFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="saved-files">
      {files.map((f) => (
        <SavedFileCard key={f.attachmentId} file={f} />
      ))}
    </div>
  );
}
