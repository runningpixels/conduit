/// The Writing studio: a draft open in the Writing area. A header (back,
/// title, the two steps, "Show AI-written text", Export), then the outline
/// while it is being agreed, or the editor once the draft is being written.
/// The chat, the outline (in the draft stage) and History live in the dock
/// (DraftDock), which App renders in the chat column. Props-driven: App owns
/// every IPC call.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Menu } from '../workspace/Menu';
import type { DraftDetail, DraftExportFormat, OutlineSection } from '../ipc/contracts';
import { DraftEditor } from './DraftEditor';
import { OutlineEditor } from './OutlineEditor';
import type { DraftPreview } from './sectionPreview';
import type { SelectionRequest } from './selectionMessage';

export interface WritingStudioProps {
  draft: DraftDetail;
  /** The draft tool the assistant is running right now, if any. */
  busyTool: string | null;
  /** A turn is running in the draft's chat: the editor is read-only. */
  streaming: boolean;
  /** Bumps when the draft was replaced from outside (a restore). */
  resetToken: number;
  onBack: () => void;
  onRename: (title: string) => void;
  onSetOutline: (sections: OutlineSection[]) => void;
  onApproveOutline: () => void;
  onSave: (markdown: string) => Promise<DraftDetail | null>;
  onUnpin: (blockId: string) => void;
  onSelectionRequest: (request: SelectionRequest) => void;
  onExport: (format: DraftExportFormat) => void;
  exporting?: boolean;
  /** Sections the assistant is writing right now (shown in the editor as a preview). */
  preview?: DraftPreview | null;
}

const SHOW_AI_KEY = 'conduit:writing-show-ai-text';

function readShowAi(): boolean {
  try {
    return window.localStorage.getItem(SHOW_AI_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeShowAi(on: boolean): void {
  try {
    window.localStorage.setItem(SHOW_AI_KEY, on ? 'true' : 'false');
  } catch {
    // A preference, not data: losing it is fine.
  }
}

const STEPS = [
  { stage: 'outline', labelId: 'writing.studio.step.outline' },
  { stage: 'draft', labelId: 'writing.studio.step.draft' },
] as const;

export function WritingStudio({
  draft,
  busyTool,
  streaming,
  resetToken,
  onBack,
  onRename,
  onSetOutline,
  onApproveOutline,
  onSave,
  onUnpin,
  onSelectionRequest,
  onExport,
  exporting = false,
  preview = null,
}: WritingStudioProps) {
  const t = useT();
  const [titleText, setTitleText] = useState(draft.title);
  const [showAi, setShowAi] = useState(readShowAi);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLButtonElement>(null);
  const closeExport = useCallback(() => setExportOpen(false), []);

  useEffect(() => {
    setTitleText(draft.title);
  }, [draft.title, draft.id]);

  const commitTitle = () => {
    const next = titleText.trim();
    if (next === '' || next === draft.title) {
      setTitleText(draft.title);
      return;
    }
    onRename(next);
  };

  const pickExport = (format: DraftExportFormat) => {
    setExportOpen(false);
    onExport(format);
  };

  const toggleAi = () => {
    setShowAi((on) => {
      writeShowAi(!on);
      return !on;
    });
  };

  const busy = streaming || busyTool != null;
  const empty = draft.markdown.trim() === '';

  return (
    <div className="writing-studio" data-stage={draft.stage}>
      <header className="studio-head">
        <div className="studio-head-row">
          <button type="button" className="btn studio-back" onClick={onBack}>
            <span aria-hidden="true">←</span> {t('writing.studio.back')}
          </button>
          <input
            className="deck-title-input studio-title"
            type="text"
            value={titleText}
            maxLength={120}
            aria-label={t('writing.studio.titleAria')}
            onChange={(e) => setTitleText(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                setTitleText(draft.title);
                e.currentTarget.blur();
              }
            }}
          />
          {busy && (
            <span className="deck-updating" role="status">
              {t('writing.studio.updating')}
            </span>
          )}
          {draft.stage === 'draft' && (
            <button
              type="button"
              className="btn writing-ai-toggle"
              aria-pressed={showAi}
              title={t('writing.studio.showAiHint')}
              onClick={toggleAi}
            >
              <span className="writing-ai-swatch" aria-hidden="true" />
              {t('writing.studio.showAi')}
            </button>
          )}
          <span className="studio-export">
            <button
              ref={exportRef}
              type="button"
              className="btn studio-export-button"
              disabled={empty || exporting}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              onClick={() => setExportOpen((open) => !open)}
            >
              {exporting ? t('writing.export.working') : t('writing.export.button')}
            </button>
            <Menu
              open={exportOpen}
              onClose={closeExport}
              triggerRef={exportRef}
              className="menu studio-export-menu"
              label={t('writing.export.menuAria')}
              dismissOnOutsidePress
            >
              <button type="button" role="menuitem" className="menu-item" onClick={() => pickExport('markdown')}>
                {t('writing.export.markdown')}
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => pickExport('html')}>
                {t('writing.export.html')}
              </button>
            </Menu>
          </span>
        </div>
        <ol className="studio-steps" aria-label={t('writing.studio.stepsAria')}>
          {STEPS.map(({ stage, labelId }) => (
            <li
              key={stage}
              className="studio-step"
              data-current={stage === draft.stage ? 'true' : undefined}
              aria-current={stage === draft.stage ? 'step' : undefined}
            >
              {t(labelId)}
            </li>
          ))}
        </ol>
      </header>
      <div className="writing-main">
        {draft.stage === 'outline' ? (
          <div className="writing-outline-stage">
            {draft.brief.trim() !== '' && (
              <p className="writing-brief">
                <span className="writing-brief-label">{t('writing.studio.brief')}</span>
                {draft.brief}
              </p>
            )}
            <OutlineEditor
              sections={draft.outline}
              stage={draft.stage}
              busy={busy}
              onChange={onSetOutline}
              onApprove={onApproveOutline}
            />
          </div>
        ) : (
          <DraftEditor
            key={draft.id}
            draft={draft}
            readOnly={streaming}
            showAiText={showAi}
            resetToken={resetToken}
            preview={streaming ? preview : null}
            onSave={onSave}
            onUnpin={onUnpin}
            onSelectionRequest={onSelectionRequest}
          />
        )}
      </div>
    </div>
  );
}
