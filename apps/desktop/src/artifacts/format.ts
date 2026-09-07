/// Shared artifact helpers.
///
/// `formatSize` and `timeAgo` used to live here and were locale-blind — they
/// hardcoded `KB`, `just now` and `2h ago`, and `.toFixed(1)` forced a `.`
/// decimal separator on every reader. They moved to `src/i18n/formatters.ts`
/// with the rest of the locale-bound formatting (D16); what is left here is
/// the part that has no language in it.
///
/// These were duplicated in `workspace/DocumentPanel.tsx` and
/// `workspace/CommandPalette.tsx`; the in-transcript artifact card is a third
/// consumer, so they live here rather than being copied again.

import type { Artifact } from '../ipc/contracts';

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

