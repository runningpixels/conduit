import type { ResearchDepth } from '../../ipc/contracts';

/// What each depth costs, shown beside its radio before the user commits.
/// These mirror the budgets Rust applies (`ResearchBudget` for a depth); the
/// run's own `budget` is what actually limits it, this is only the preview.
export const DEPTH_ORDER: readonly ResearchDepth[] = ['quick', 'standard', 'deep'];

export const DEPTH_ESTIMATE: Record<ResearchDepth, { searches: number; pages: number; minutes: number }> = {
  quick: { searches: 8, pages: 15, minutes: 10 },
  standard: { searches: 20, pages: 40, minutes: 20 },
  deep: { searches: 50, pages: 100, minutes: 40 },
};

export const MAX_SUB_QUESTIONS = 6;

/// Literal catalog ids, so the i18n cross-reference sees every one.
export const DEPTH_LABEL_ID: Record<ResearchDepth, string> = {
  quick: 'chat.research.depth.quick',
  standard: 'chat.research.depth.standard',
  deep: 'chat.research.depth.deep',
};
