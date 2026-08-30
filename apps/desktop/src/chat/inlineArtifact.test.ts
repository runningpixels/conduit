import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactKind } from '../ipc/contracts';
import { detectArtifactCandidates } from './artifactCandidates';
import {
  findPromotedArtifact,
  inlineArtifactIds,
  isPromotable,
  shouldRenderAsCard,
} from './inlineArtifact';

function artifact(over: Partial<Artifact> & { id: string }): Artifact {
  return {
    conversationId: 'c1',
    kind: 'html',
    title: 'Untitled',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Artifact;
}

function candidateFor(info: string, body: string) {
  const [c] = detectArtifactCandidates(`\`\`\`${info}\n${body}\n\`\`\``);
  return c;
}

describe('findPromotedArtifact', () => {
  const candidate = candidateFor('html', '<html><head><title>Report</title></head></html>');

  it('matches on sourceMessageId and kind even when the title differs', () => {
    // The regression this exists for: a tool-created artifact is titled from
    // the tool argument, the candidate from the <title> tag. The old exact
    // title match failed here, so the block offered "Open as artifact" and
    // clicking it created a second artifact for content that already existed.
    const found = findPromotedArtifact(
      [artifact({ id: 'a1', title: 'Quarterly numbers', sourceMessageId: 'msg-1' })],
      'msg-1',
      candidate,
    );
    expect(found?.id).toBe('a1');
  });

  it('ignores artifacts from other messages', () => {
    const found = findPromotedArtifact(
      [artifact({ id: 'a1', sourceMessageId: 'msg-2' })],
      'msg-1',
      candidate,
    );
    expect(found).toBeUndefined();
  });

  it('ignores artifacts of a different kind', () => {
    const found = findPromotedArtifact(
      [artifact({ id: 'a1', kind: 'markdown' as ArtifactKind, sourceMessageId: 'msg-1' })],
      'msg-1',
      candidate,
    );
    expect(found).toBeUndefined();
  });

  it('falls back to the title when one turn produced several of a kind', () => {
    const found = findPromotedArtifact(
      [
        artifact({ id: 'a1', title: 'Something else', sourceMessageId: 'msg-1' }),
        artifact({ id: 'a2', title: 'Report', sourceMessageId: 'msg-1' }),
      ],
      'msg-1',
      candidate,
    );
    expect(found?.id).toBe('a2');
  });
});

describe('shouldRenderAsCard', () => {
  it('collapses document kinds at any length', () => {
    expect(shouldRenderAsCard(candidateFor('html', '<p>hi</p>'))).toBe(true);
    expect(shouldRenderAsCard(candidateFor('json', '{"a":1}'))).toBe(true);
    expect(shouldRenderAsCard(candidateFor('md', '# Title'))).toBe(true);
  });

  it('keeps short code snippets inline and collapses long ones', () => {
    expect(shouldRenderAsCard(candidateFor('bash', 'rm -r dir'))).toBe(false);
    expect(shouldRenderAsCard(candidateFor('python', 'x = 1\n'.repeat(40)))).toBe(true);
  });

  it('keeps text fences inline — sample output belongs in the reading flow', () => {
    expect(shouldRenderAsCard(candidateFor('text', 'Expected Return = 13.5%'))).toBe(false);
  });

  it('never collapses while streaming', () => {
    expect(shouldRenderAsCard(candidateFor('html', '<p>hi</p>'), true)).toBe(false);
  });

  it('keeps mermaid and math fences in the reading flow even when long', () => {
    const body = 'flowchart TD\n' + 'A-->B\n'.repeat(40);
    expect(shouldRenderAsCard(candidateFor('mermaid', body))).toBe(false);
    expect(shouldRenderAsCard(candidateFor('math', '\\int x\n'.repeat(40)))).toBe(false);
  });
});

describe('inlineArtifactIds', () => {
  const content = '```html\n<html><head><title>Report</title></head></html>\n```';

  it('reports artifacts already shown as an in-body card', () => {
    const ids = inlineArtifactIds(
      detectArtifactCandidates(content),
      [artifact({ id: 'a1', sourceMessageId: 'msg-1' })],
      'msg-1',
    );
    expect([...ids]).toEqual(['a1']);
  });

  it('omits artifacts with no fence in the text, so the strip still shows them', () => {
    const ids = inlineArtifactIds([], [artifact({ id: 'a1', sourceMessageId: 'msg-1' })], 'msg-1');
    expect(ids.size).toBe(0);
  });

  // Content visible inline as *source* counts too, not just content rendered as
  // a card. Restricting this to cards meant a `text` artifact — which never
  // collapses — was reported twice on the same turn: once inline, once in the
  // end-of-turn strip.
  it('suppresses a fence shown inline as source', () => {
    const ids = inlineArtifactIds(
      detectArtifactCandidates('```text\nExpected Return = 13.5%\n```'),
      [artifact({ id: 'a1', kind: 'text' as ArtifactKind, sourceMessageId: 'msg-1' })],
      'msg-1',
    );
    expect([...ids]).toEqual(['a1']);
  });

  it('is empty without a messageId', () => {
    const ids = inlineArtifactIds(
      detectArtifactCandidates(content),
      [artifact({ id: 'a1', sourceMessageId: 'msg-1' })],
      undefined,
    );
    expect(ids.size).toBe(0);
  });
});

describe('isPromotable', () => {
  // Sized against the real data: every accidental artifact in the workspace was
  // under 200 bytes, every genuine document over 4,400.
  it('refuses the snippets that actually became junk artifacts', () => {
    expect(isPromotable(candidateFor('bash', 'rm -r directory_name'))).toBe(false);
    expect(
      isPromotable(candidateFor('text', 'Expected Return = Risk-free Rate + Beta × Market Risk Premium')),
    ).toBe(false);
    expect(
      isPromotable(
        candidateFor('text', 'Expected Return = 3% + 1.5 × (10% - 3%)\n = 3% + 1.5 × 7%\n = 13.5%'),
      ),
    ).toBe(false);
  });

  it('allows a real document', () => {
    expect(isPromotable(candidateFor('html', '<p>row</p>\n'.repeat(60)))).toBe(true);
  });

  it('measures bytes, not characters', () => {
    // 100 multi-byte characters are under the floor by count but over it by
    // bytes — the card reports bytes, so the gate must agree with it.
    expect(isPromotable(candidateFor('text', '×'.repeat(120)))).toBe(true);
    expect(isPromotable(candidateFor('text', 'x'.repeat(120)))).toBe(false);
  });
});
