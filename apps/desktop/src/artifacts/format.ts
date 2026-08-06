/// Shared artifact metadata formatters.
///
/// These were duplicated in `workspace/DocumentPanel.tsx` and
/// `workspace/CommandPalette.tsx`; the in-transcript artifact card is a third
/// consumer, so they live here rather than being copied again.

import type { Artifact } from '../ipc/contracts';

/// Human-readable byte size. `fallback` covers artifacts with no known size —
/// the panel foot wants an em dash, the command palette wants nothing.
export function formatSize(bytes?: number, fallback = '—'): string {
  if (bytes == null) return fallback;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/// Raw inline text for Copy + the Source pane: prefer `contentText`, fall back
/// to pretty-printed `contentJson`, else empty (file-backed artifacts must be
/// fetched with `getArtifactContentBytes`).
export function inlineArtifactText(artifact: Artifact): string {
  if (artifact.contentText != null) return artifact.contentText;
  if (artifact.contentJson != null) {
    try {
      return JSON.stringify(artifact.contentJson, null, 2);
    } catch {
      return String(artifact.contentJson);
    }
  }
  return '';
}

/// Compact relative timestamp for the foot strip + ⋯ metadata block.
export function timeAgo(iso?: string): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
