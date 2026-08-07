import { useState } from 'react';
import type { Artifact } from '../ipc/contracts';
import { languageFromMime } from '../artifacts/selectRenderer';
import { renderHighlightedCode, useHighlightTokens } from '../artifacts/codeHighlight';
import type { ArtifactCandidate } from './messageSegments';
import { findPromotedArtifact, isPromotable } from './inlineArtifact';
import { CheckIcon, CopyIcon, PlusIcon } from '../icons';

const KIND_LABEL: Record<ArtifactCandidate['kind'], string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

function languageLabel(candidate: ArtifactCandidate): string {
  const fromMime = languageFromMime(candidate.mimeType);
  if (fromMime) return fromMime;
  const infoLang = candidate.info.split(/\s+/)[0]?.toLowerCase();
  if (infoLang) return infoLang;
  return KIND_LABEL[candidate.kind] ?? candidate.kind;
}

interface InlineCodeBlockProps {
  candidate: ArtifactCandidate;
  streaming?: boolean;
  messageId?: string;
  artifacts?: Artifact[];
  promoteDisabled?: boolean;
  onPromote?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
}

/** Inline source block for fenced assistant output — readable in chat with copy
 *  and optional promote/open-as-artifact actions. */
export function InlineCodeBlock({
  candidate,
  streaming,
  messageId,
  artifacts = [],
  promoteDisabled,
  onPromote,
  onOpenArtifact,
}: InlineCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const lang = languageLabel(candidate);
  const highlighted = useHighlightTokens(candidate.body, lang);
  const promoted = messageId ? findPromotedArtifact(artifacts, messageId, candidate) : undefined;
  // A formula or a one-line command is part of the answer, not a document.
  const canPromote =
    !!messageId && !!onPromote && !streaming && !promoted && isPromotable(candidate);
  const canOpen = !!promoted && !!onOpenArtifact;

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

  async function handlePromote() {
    if (!messageId || !onPromote || pending) return;
    setPending(true);
    try {
      await onPromote(messageId, candidate);
    } finally {
      setPending(false);
    }
  }

  // `data-plain` marks a block Prism could not tokenise. It sits on the wrapper
  // so the language chip can match the body's colour, and on the <pre> so the
  // body itself takes it.
  const plain = highlighted ? undefined : 'true';

  return (
    <div className="inline-code-block" data-plain={plain}>
      <div className="inline-code-block-head">
        <span className="inline-code-block-lang">{lang}</span>
        <div className="inline-code-block-actions">
          <button
            type="button"
            className="icon-btn inline-code-block-btn"
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            onClick={handleCopy}
            disabled={!candidate.body || streaming}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {canOpen && (
            <button
              type="button"
              className="btn ghost inline-code-block-promote"
              onClick={() => onOpenArtifact!(promoted!.id)}
            >
              Open artifact
            </button>
          )}
          {canPromote && (
            <button
              type="button"
              className="btn ghost inline-code-block-promote"
              disabled={promoteDisabled || pending}
              title={`Open ${KIND_LABEL[candidate.kind].toLowerCase()} in the document panel`}
              onClick={handlePromote}
            >
              <PlusIcon />
              Open as artifact
            </button>
          )}
        </div>
      </div>
      <pre className="inline-code-block-body scroll" data-plain={plain}>
        <code>
          {highlighted ? renderHighlightedCode(highlighted) : candidate.body}
          {streaming && <span className="cursor" aria-hidden="true" />}
        </code>
      </pre>
    </div>
  );
}
