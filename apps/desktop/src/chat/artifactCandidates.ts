import type { ArtifactCandidate } from './messageSegments';
import { parseMessageSegments } from './messageSegments';

export type { ArtifactCandidate };
export type { MessageSegment } from './messageSegments';

export function detectArtifactCandidates(content: string): ArtifactCandidate[] {
  return parseMessageSegments(content)
    .filter((s): s is { type: 'fence'; candidate: ArtifactCandidate; raw: string } => s.type === 'fence')
    .map((s) => s.candidate);
}
