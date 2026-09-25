import { useLayoutEffect, useRef, useState } from 'react';
import type { Artifact } from '../ipc/contracts';
import { languageFromMime } from '../artifacts/selectRenderer';
import { renderHighlightedCode, useHighlightTokens } from '../artifacts/codeHighlight';
import { explicitTitle, type ArtifactCandidate } from './messageSegments';
import { findPromotedArtifact, isPromotable } from './inlineArtifact';
import { CheckIcon, CopyIcon, PlusIcon } from '../icons';
import { useT, type Translate } from '../i18n';
import { useFormatters, type Formatters } from '../i18n/formatters';
import { documentKindLabel } from '../lib/documentKind';

// Artifact kind names — format identifiers, not prose (see the same map and
// comment in `ArtifactResultCard.tsx`).
function languageLabel(candidate: ArtifactCandidate, t: Translate): string {
  const fromMime = languageFromMime(candidate.mimeType);
  if (fromMime) return fromMime;
  const infoLang = candidate.info.split(/\s+/)[0]?.toLowerCase();
  if (infoLang) return infoLang;
  return documentKindLabel(candidate.kind, t);
}

/// Within this many pixels of the bottom, the reader is "at the tail" and the
/// body keeps following new lines; scrolling further up opts out.
const FOLLOW_SLACK_PX = 24;

/**
 * "Writing “Bonds 101”… · 214 lines · 18 kB" while a fence streams.
 *
 * The body is capped at 420px, so without this a long fence showed its first
 * twenty lines, standing still, for however many minutes the rest took to
 * arrive — indistinguishable from a finished block whose card never came.
 * The strings are the tool-driven document write's (`documentWriteScan.ts`),
 * so both ways of producing a document read the same.
 */
function streamingStatus(candidate: ArtifactCandidate, t: Translate, fmt: Formatters): string | undefined {
  if (!candidate.body) return undefined;
  const title = explicitTitle(candidate.kind, candidate.body);
  const label = title
    ? t('chat.documentWrite.writingTitled', { title })
    : candidate.kind === 'html' || candidate.kind === 'markdown'
      ? t('chat.documentWrite.writingKind', { kind: candidate.kind })
      : undefined;
  const detail = t('chat.documentWrite.progress', {
    lines: candidate.body.replace(/\n$/, '').split('\n').length,
    size: fmt.size(new TextEncoder().encode(candidate.body).length),
  });
  return label ? `${label} · ${detail}` : detail;
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
  const t = useT();
  const fmt = useFormatters();
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const lang = languageLabel(candidate, t);
  const highlighted = useHighlightTokens(candidate.body, lang);
  const promoted = messageId ? findPromotedArtifact(artifacts, messageId, candidate) : undefined;
  // A formula or a one-line command is part of the answer, not a document.
  const canPromote =
    !!messageId && !!onPromote && !streaming && !promoted && isPromotable(candidate);
  const canOpen = !!promoted && !!onOpenArtifact;

  // Follow the tail while streaming, unless the reader has scrolled up to read.
  const bodyRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (streaming && el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [candidate.body, streaming]);
  function handleScroll() {
    const el = bodyRef.current;
    if (!el || !streaming) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  }
  const status = streaming ? streamingStatus(candidate, t, fmt) : undefined;

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
        {status && (
          <span className="inline-code-block-status" aria-live="off" title={status}>
            {status}
          </span>
        )}
        <div className="inline-code-block-actions">
          <button
            type="button"
            className="icon-btn inline-code-block-btn"
            aria-label={copied ? t('chat.codeBlock.copied') : t('chat.codeBlock.copy')}
            title={copied ? t('chat.codeBlock.copied') : t('chat.codeBlock.copy')}
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
              {t('chat.codeBlock.openArtifact')}
            </button>
          )}
          {canPromote && (
            <button
              type="button"
              className="btn ghost inline-code-block-promote"
              disabled={promoteDisabled || pending}
              title={t('chat.codeBlock.openInDocumentPanel', { kind: candidate.kind })}
              onClick={handlePromote}
            >
              <PlusIcon />
              {t('chat.codeBlock.openAsArtifact')}
            </button>
          )}
        </div>
      </div>
      <pre
        ref={bodyRef}
        className="inline-code-block-body scroll"
        data-plain={plain}
        onScroll={handleScroll}
      >
        <code>
          {highlighted ? renderHighlightedCode(highlighted) : candidate.body}
          {streaming && <span className="cursor" aria-hidden="true" />}
        </code>
      </pre>
    </div>
  );
}
