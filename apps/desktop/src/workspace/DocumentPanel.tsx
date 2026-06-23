import { useMemo, useState } from 'react';
import { DOC_FILE_TABS, type FileState } from '../mock/workspace';
import { CopyIcon, ExternalIcon, FilePlainIcon, CheckIcon, AlertIcon } from '../icons';

type DocTab = 'preview' | 'source' | 'file';

interface DocFile {
  name: string;
  state: FileState;
  subtitle: string;
}

const STATE_LABEL: Record<FileState, string> = {
  ok: 'saved',
  modified: 'changed',
  missing: 'missing',
};

const STATE_TONE: Record<FileState, 'ok' | 'warn' | 'bad'> = {
  ok: 'ok',
  modified: 'warn',
  missing: 'bad',
};

/** Escapes a string for safe insertion into HTML text. The Preview pane renders
 *  escaped content only this phase — the hardened markdown/code/JSON renderers
 *  land in Phase 5 and slot into the same pane. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const PREVIEW_SOURCE = `# Open issue triage

## Needs attention
- #412 - Streaming cuts off mid-token on cancel (regression)
- #408 - OpenAI adapter drops usage events (regression)

## Stale
- #377 - Connector consent copy unclear (18d idle)

## Routine
- #421 - Add Ollama health check on launch
- #419 - Keychain prompt copy tweak`;

const FILE_META: Array<{ k: string; v: string; dim?: boolean }> = [
  { k: 'Path', v: 'Artifacts/triage-note.md' },
  { k: 'Hash', v: 'sha256:9f3a...c21e' },
  { k: 'Size', v: '1.8 KB' },
  { k: 'MIME', v: 'text/markdown' },
  { k: 'Origin', v: 'Repo triage note for Slack', dim: true },
  { k: 'Cloud', v: 'Not published - local only', dim: true },
];

interface DocumentPanelProps {
  activeName: string;
  activeState: FileState;
  activeSubtitle: string;
  docTab: DocTab;
  fileState: FileState;
  onSelectTab: (tab: DocTab) => void;
  onSetFileState: (state: FileState) => void;
  onCloseTab?: (name: string) => void;
}

/** v5 right-hand document panel: doc-head, artifact-tabs (editor-style open-file
 *  tabs with per-file state dots + close), doc-tabs (Preview/Source/File),
 *  doc-body panes, file-state banners with recovery rows, and doc-foot
 *  (sync status + Publish). The file-state machine is local; real artifact
 *  state lands in Phase 5. */
export function DocumentPanel({
  activeName,
  activeState,
  activeSubtitle,
  docTab,
  fileState,
  onSelectTab,
  onSetFileState,
}: DocumentPanelProps) {
  const [copied, setCopied] = useState(false);

  const toneClass = `status-pill ${STATE_TONE[activeState]}`;
  const label = STATE_LABEL[activeState];

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(PREVIEW_SOURCE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  const escapedPreview = useMemo(() => PREVIEW_SOURCE, []);

  return (
    <section
      className="doc-panel"
      aria-label="Document panel"
      data-doc-tab={docTab}
      data-file-state={fileState}
    >
      <div className="doc-head">
        <div className="ficon"><FilePlainIcon /></div>
        <div className="doc-title">
          <b>{activeName}</b>
          <small>{activeSubtitle}</small>
        </div>
        <span className={toneClass}>{label}</span>
        <span className="ver">v4 current</span>
        <div className="doc-actions">
          <button className="icon-btn" type="button" aria-label="Reveal in Explorer" title="Reveal in Explorer">
            <ExternalIcon />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label={copied ? 'Copied' : 'Copy'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={handleCopy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      <div className="artifact-tabs" aria-label="Open artifacts">
        {DOC_FILE_TABS.map((tab) => (
          <button
            key={tab.name}
            className={`artifact-file-tab${tab.name === activeName ? ' active' : ''}`}
            type="button"
            data-state={tab.state}
            title={tab.subtitle}
          >
            <FilePlainIcon />
            <span className="tab-name">{tab.name}</span>
            <span className={`tab-state${tab.state === 'ok' ? '' : tab.state === 'modified' ? ' warn' : ' bad'}`} />
            <span className="tab-close" aria-hidden="true">&times;</span>
          </button>
        ))}
        <button className="artifact-add-tab" type="button" aria-label="Open another artifact" title="Open another artifact">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <div className="doc-tabs">
        <button className="doc-tab" data-doc-tab="preview" type="button" onClick={() => onSelectTab('preview')}>
          Preview
        </button>
        <button className="doc-tab" data-doc-tab="source" type="button" onClick={() => onSelectTab('source')}>
          Source
        </button>
        <button className="doc-tab" data-doc-tab="file" type="button" onClick={() => onSelectTab('file')}>
          File
        </button>
        <span className="doc-tab-spacer" />
        <span className="state-toggle">
          Demo state
          <button
            className={`state-pill-btn${fileState === 'ok' ? ' on' : ''}`}
            type="button"
            data-state="ok"
            onClick={() => onSetFileState('ok')}
          >
            Saved
          </button>
          <button
            className={`state-pill-btn${fileState === 'modified' ? ' on' : ''}`}
            type="button"
            data-state="modified"
            onClick={() => onSetFileState('modified')}
          >
            Changed
          </button>
          <button
            className={`state-pill-btn${fileState === 'missing' ? ' on' : ''}`}
            type="button"
            data-state="missing"
            onClick={() => onSetFileState('missing')}
          >
            Missing
          </button>
        </span>
      </div>

      <div className="doc-body scroll">
        <div className="doc-banner warn">
          <strong>Modified outside Conduit.</strong> The file on disk changed since Conduit last read it. Review the disk copy before continuing.
          <div className="recovery-row">
            <button className="btn primary" type="button">Review disk changes</button>
            <button className="btn" type="button">Use disk copy</button>
            <button className="btn ghost" type="button">Keep current view</button>
          </div>
        </div>
        <div className="doc-banner bad">
          <strong>File missing.</strong> Conduit cannot find this artifact at its indexed path. The catalog entry is intact, but the payload is gone from the workspace.
          <div className="recovery-row">
            <button className="btn primary" type="button">Locate file...</button>
            <button className="btn ghost" type="button">Remove from workspace list</button>
          </div>
        </div>

        <div className="doc-pane" data-doc-pane="preview">
          <article className="doc">
            <h1>Open issue triage</h1>
            <p className="sub"># 5 open - sorted by recent activity</p>
            <h2>Needs attention</h2>
            <ul>
              <li><b>#412 - Streaming cuts off mid-token on cancel</b><span className="tag">regression</span></li>
              <li><b>#408 - OpenAI adapter drops usage events</b><span className="tag">regression</span></li>
            </ul>
            <h2>Stale</h2>
            <ul>
              <li><b>#377 - Connector consent copy unclear</b><span className="tag lo">18d idle</span></li>
            </ul>
            <h2>Routine</h2>
            <ul>
              <li><b>#421 - Add Ollama health check on launch</b></li>
              <li><b>#419 - Keychain prompt copy tweak</b></li>
            </ul>
            <p>Suggested next step: pick up the two regressions before the next signed build, since both touch the streaming path.</p>
          </article>
        </div>

        <div className="doc-pane" data-doc-pane="source">
          {/* Escaped-only this phase; the hardened renderer lands in Phase 5. */}
          <div
            className="src-block"
            dangerouslySetInnerHTML={{ __html: escapeHtml(escapedPreview) }}
          />
        </div>

        <div className="doc-pane" data-doc-pane="file">
          <p style={{ margin: '0 0 12px', fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5, maxWidth: '860px' }}>
            The local store indexes this artifact. The canonical payload is the file below, not a database blob.
          </p>
          <div className="file-meta">
            {FILE_META.map((row) => (
              <div className="row" key={row.k}>
                <span className="k">{row.k}</span>
                <span className={`v${row.dim ? ' dim' : ''}`}>{row.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="doc-foot">
        <span className="foot-ok sync"><CheckIcon />Saved on device - not synced</span>
        <span className="foot-warn sync"><AlertIcon />Modified outside app</span>
        <span className="foot-bad sync"><AlertIcon />File missing</span>
        <button className="publish-btn" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg>
          Publish
        </button>
      </div>
    </section>
  );
}