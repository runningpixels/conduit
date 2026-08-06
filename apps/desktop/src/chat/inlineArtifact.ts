/// Shared rules for how a fenced block relates to a persisted artifact, and
/// whether it is presented as source or as a card.
///
/// Three call sites need the same answers and must not drift: `ChatProse`
/// (which form to render), `InlineCodeBlock` (which header action to offer),
/// and `AssistantMessage` (which end-of-turn cards to suppress as duplicates).

import type { Artifact, ArtifactKind } from '../ipc/contracts';
import type { ArtifactCandidate } from './messageSegments';

/// A `code` fence longer than this is a deliverable rather than something you
/// read in the flow of the answer, so it collapses to a card.
export const INLINE_CODE_MAX_LINES = 20;

/// Below this, a fence is a snippet, not a document, and cannot be promoted.
///
/// Nothing used to refuse a promotion, so a click turned a one-line formula or
/// `rm -r directory_name` into a stored artifact with a panel tab. Measured
/// against real data: every accidental artifact was under 200 bytes and every
/// genuine document was over 4,400. Matches the `MIN_UNLABELED_BODY` precedent
/// in `messageSegments.ts`.
export const MIN_PROMOTABLE_BYTES = 200;

/**
 * Whether this fence is substantial enough to become an artifact.
 *
 * Deliberately size-based rather than kind-based: the junk was two `text`
 * formulas *and* a 20-byte `code` command, so a rule that only excluded `text`
 * would have missed a third of it. Byte length, not character count, so the
 * threshold agrees with the size the card displays.
 */
export function isPromotable(candidate: ArtifactCandidate): boolean {
  return new TextEncoder().encode(candidate.body).length >= MIN_PROMOTABLE_BYTES;
}

/// Kinds that are viewed rather than read: they always collapse. `text` is
/// deliberately absent — a text fence is usually sample output or a formula
/// that belongs in the reading flow, not a document.
const DOCUMENT_KINDS: readonly ArtifactKind[] = ['html', 'markdown', 'json'];

/**
 * The artifact this fence produced, if any.
 *
 * Matching used to require an exact `title` match as well. That failed for the
 * common case: a tool-created artifact's title is the model's `title` argument,
 * while `candidate.title` is derived from the body (`<title>`, first heading,
 * or first line). When they differed the fence looked unpromoted, so the header
 * offered "Open as artifact" and clicking it created a *second* artifact for
 * content that already existed.
 *
 * `sourceMessageId` + `kind` is enough whenever the turn produced one artifact
 * of that kind, which is overwhelmingly the common case. Title is used only to
 * disambiguate when a single turn produced several of the same kind.
 */
export function findPromotedArtifact(
  artifacts: readonly Artifact[],
  messageId: string,
  candidate: ArtifactCandidate,
): Artifact | undefined {
  const sameKind = artifacts.filter(
    (a) => a.sourceMessageId === messageId && a.kind === candidate.kind,
  );
  if (sameKind.length <= 1) return sameKind[0];
  return sameKind.find((a) => a.title === candidate.title);
}

/**
 * Whether this fence renders as an artifact card instead of source.
 *
 * While streaming, always false: the inline block is the only place generation
 * is visible (the document panel's pending state is a skeleton), so the source
 * stays on screen until the turn completes and then collapses.
 */
export function shouldRenderAsCard(candidate: ArtifactCandidate, streaming?: boolean): boolean {
  if (streaming) return false;
  if (DOCUMENT_KINDS.includes(candidate.kind)) return true;
  return candidate.kind === 'code' && countLines(candidate.body) > INLINE_CODE_MAX_LINES;
}

function countLines(body: string): number {
  if (!body) return 0;
  return body.replace(/\n$/, '').split('\n').length;
}

/**
 * Artifact ids whose content is already visible in the message body, so the
 * end-of-turn strip can skip them. Artifacts with no fence in the text — the
 * tool-created-only case — are absent here and still get a card.
 *
 * This covers a fence rendered as source as well as one rendered as a card.
 * Restricting it to cards meant a `text` artifact — which never collapses —
 * was reported twice in one turn: once inline, once in the strip.
 */
export function inlineArtifactIds(
  candidates: readonly ArtifactCandidate[],
  artifacts: readonly Artifact[],
  messageId: string | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!messageId) return ids;
  for (const candidate of candidates) {
    const promoted = findPromotedArtifact(artifacts, messageId, candidate);
    if (promoted) ids.add(promoted.id);
  }
  return ids;
}
