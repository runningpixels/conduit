/// Card presentation for a fenced block that is a document rather than a
/// snippet (§8.5). Replaces the source dump in the transcript; the source stays
/// one click away behind `Show code`.
///
/// When the fence already produced an artifact this delegates to
/// `ArtifactResultCard` so the ⋯ actions (copy / reveal / export) exist in one
/// implementation only. When it has not, the card offers the same primary
/// action — `Open` promotes and opens in a single click.

import { useState } from 'react';
import type { Artifact, ArtifactKind, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './messageSegments';
import { renderHighlightedCode, useHighlightTokens } from '../artifacts/codeHighlight';
import { languageFromMime } from '../artifacts/selectRenderer';
import { formatSize } from '../artifacts/format';
import { ArtifactResultCard } from './ArtifactResultCard';
import { isPromotable } from './inlineArtifact';
import { CheckIcon, CopyIcon, FilePlainIcon } from '../icons';

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

function candidateLanguage(candidate: ArtifactCandidate): string {
  const fromMime = languageFromMime(candidate.mimeType);
  if (fromMime) return fromMime;
  const infoLang = candidate.info.split(/\s+/)[0]?.toLowerCase();
  if (infoLang) return infoLang;
  return KIND_LABEL[candidate.kind] ?? candidate.kind;
}

/// Byte length rather than `body.length`, so the subtitle agrees with the size
/// the artifact reports once it is persisted.
function byteSize(body: string): number {
  return new TextEncoder().encode(body).length;
}

interface InlineArtifactCardProps {
  candidate: ArtifactCandidate;
  /// The artifact this fence produced, when it has one.
  promoted?: Artifact;
  messageId?: string;
  fileState?: FileState;
  onPromote?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onStatus?: (message: string) => void;
}

export function InlineArtifactCard({
  candidate,
  promoted,
  messageId,
  fileState,
  onPromote,
  onOpenArtifact,
  onStatus,
}: InlineArtifactCardProps) {
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const lang = candidateLanguage(candidate);
  const highlighted = useHighlightTokens(showCode ? candidate.body : '', lang);

  const title = candidate.title || 'Untitled';
  const kindLabel = KIND_LABEL[candidate.kind] ?? candidate.kind;
  const size = formatSize(byteSize(candidate.body), '');

  async function handleCopy() {
    if (!candidate.body) return;
    try {
      await navigator.clipboard.writeText(candidate.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  async function handleOpen() {
    if (!messageId || !onPromote || pending) return;
    setPending(true);
    try {
      await onPromote(messageId, candidate);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inline-artifact">
      {promoted && onOpenArtifact ? (
        <ArtifactResultCard
          artifact={promoted}
          fileState={fileState}
          onOpen={onOpenArtifact}
          onStatus={onStatus}
        />
      ) : (
        <div className="artifact-card">
          <span className="artifact-card-icon" aria-hidden="true">
            <FilePlainIcon />
          </span>
          <div className="artifact-card-body">
            <div className="artifact-card-title">
              <span className="artifact-card-name" title={title}>{title}</span>
            </div>
            <div className="artifact-card-meta">{size ? `${kindLabel} · ${size}` : kindLabel}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            onClick={() => void handleCopy()}
            disabled={!candidate.body}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {/* `Open` promotes, so it carries the same size gate as the fence
              header's button. Every document-kind fence clears it comfortably;
              this is a guard, not a visible change. */}
          {messageId && onPromote && isPromotable(candidate) && (
            <button
              type="button"
              className="btn artifact-card-open"
              disabled={pending}
              title={`Open this ${kindLabel.toLowerCase()} in the artifact panel`}
              onClick={() => void handleOpen()}
            >
              {pending ? 'Opening…' : 'Open'}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className="inline-artifact-toggle"
        aria-expanded={showCode}
        onClick={() => setShowCode((open) => !open)}
      >
        {showCode ? 'Hide code' : 'Show code'}
      </button>
      {showCode && (
        <pre className="inline-artifact-source" data-plain={highlighted ? undefined : 'true'}>
          <code>{highlighted ? renderHighlightedCode(highlighted) : candidate.body}</code>
        </pre>
      )}
    </div>
  );
}
