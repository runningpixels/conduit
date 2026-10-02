/// The one summary line of a compact assistant turn (Slides studio dock).
///
/// Everything in a turn that is not its text reply, thinking and tool calls,
/// folds into one line: "Changed slides 2, 4 · 6 steps", "Drafted the
/// storyline", or "Thought for 1m 53s" when no tool ran. Pure: it takes the
/// translator and a duration formatter rather than reading React context.

import type { Translate } from '../i18n';
import type { AssistantStreamState, ToolCallState } from './streamState';

type Duration = (ms: number) => string;

function succeeded(tc: ToolCallState): boolean {
  return tc.status !== 'failed' && tc.status !== 'cancelled' && tc.consent !== 'denied';
}

function slideNumber(tc: ToolCallState, slideIds: readonly string[]): number | null {
  const id = tc.arguments?.slide_id;
  if (typeof id !== 'string') return null;
  const at = slideIds.indexOf(id);
  return at >= 0 ? at + 1 : null;
}

/** What the deck tools of a finished turn did, in words; empty when none ran. */
export function deckChangeSummary(
  state: Pick<AssistantStreamState, 'toolCalls'>,
  slideIds: readonly string[],
  t: Translate,
): string {
  const calls = state.toolCalls.filter(succeeded);
  const parts: string[] = [];
  if (calls.some((c) => c.name === 'set_storyline')) parts.push(t('chat.compact.storyline'));
  const added = calls.filter((c) => c.name === 'add_slide').length;
  if (added > 0) parts.push(t('chat.compact.added', { count: added }));
  const changed = new Set<number>();
  for (const c of calls) {
    if (c.name === 'update_slide' || c.name === 'patch_slide' || c.name === 'move_slide') {
      const n = slideNumber(c, slideIds);
      if (n != null) changed.add(n);
    }
  }
  if (changed.size > 0) {
    const slides = [...changed].sort((a, b) => a - b).join(', ');
    parts.push(t('chat.compact.changed', { count: changed.size, slides }));
  }
  const removed = calls.filter((c) => c.name === 'delete_slide').length;
  if (removed > 0) parts.push(t('chat.compact.removed', { count: removed }));
  if (calls.some((c) => c.name === 'set_theme')) parts.push(t('chat.compact.theme'));
  if (calls.some((c) => c.name === 'replace_in_deck')) parts.push(t('chat.compact.replaced'));
  return parts.join(', ');
}

/** "Thought for 1m 53s" from the reasoning blocks' timing; "Thought" when it was never recorded. */
export function thoughtSummary(
  state: Pick<AssistantStreamState, 'reasoning'>,
  t: Translate,
  duration: Duration,
): string {
  let ms = 0;
  for (const block of state.reasoning) {
    if (block.startedAt != null && block.lastDeltaAt != null) ms += Math.max(0, block.lastDeltaAt - block.startedAt);
  }
  return ms > 0
    ? t('chat.reasoning.thoughtFor', { duration: duration(Math.max(1000, ms)) })
    : t('chat.reasoning.thought');
}

/** The live line while the turn runs: what the newest running deck tool is doing. */
export function liveSummary(
  state: Pick<AssistantStreamState, 'toolCalls' | 'agentPhase'>,
  slideIds: readonly string[],
  t: Translate,
): string {
  const running = [...state.toolCalls].reverse().find((c) => (c.status == null ? !c.complete : c.status === 'running' || c.status === 'pending'));
  if (running) {
    const n = slideNumber(running, slideIds);
    switch (running.name) {
      case 'update_slide':
      case 'patch_slide':
        return n != null ? t('chat.compact.live.updatingSlide', { n }) : t('chat.compact.live.updating');
      case 'add_slide':
        return t('chat.compact.live.adding');
      case 'delete_slide':
        return t('chat.compact.live.removing');
      case 'move_slide':
        return t('chat.compact.live.moving');
      case 'set_storyline':
        return t('chat.compact.live.storyline');
      case 'set_theme':
        return t('chat.compact.live.theme');
      case 'replace_in_deck':
        return t('chat.compact.live.replacing');
      case 'read_deck':
        return t('chat.compact.live.reading');
      default:
        break;
    }
  }
  return state.agentPhase?.label || t('chat.compact.live.working');
}
