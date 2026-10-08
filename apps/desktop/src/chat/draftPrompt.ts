import { appName } from '../brand';
import type { DraftDetail, ResearchMaterial } from '../ipc/contracts';
import documentsText from '../prompts/draft-documents.md?raw';
import noInventionText from '../prompts/draft-no-invention.md?raw';
import draftSystemTemplate from '../prompts/draft-system.md?raw';
import webSearchText from '../prompts/draft-web-search.md?raw';
import { fillTemplate, promptText } from '../prompts/shared';

/** Longest block text the per-turn outline carries; read_draft returns the rest. */
const BLOCK_TEXT_CHARS = 80;

/** Blocks listed per turn before the list is cut (read_draft covers the rest). */
const MAX_LISTED_BLOCKS = 400;

/** The sources a draft's turn can use (its Sources tab). */
export interface DraftPromptSources {
  /** web_search and web_fetch are offered this turn. */
  webSearch?: boolean;
  /** Document collections are attached to the draft's chat. */
  documents?: boolean;
}

/** Shown when no source backs a fact, in every draft turn. */
export const DRAFT_NO_INVENTION_RULE = promptText(noInventionText);

/**
 * System appendix for a chat bound to a Writing draft. It replaces the
 * artifact appendix: that one teaches the document tools, which in a draft
 * chat would write a loose document instead of the draft. `sources` adds the
 * rules for the sources the draft uses.
 */
export function draftSystemAppendix(sources: DraftPromptSources = {}): string {
  return fillTemplate(draftSystemTemplate, appName(), {
    no_invention: DRAFT_NO_INVENTION_RULE,
    web_search: sources.webSearch ? promptText(webSearchText) : null,
    documents: sources.documents ? promptText(documentsText) : null,
  });
}

function blockText(markdown: string, start: number, end: number): string {
  const text = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > BLOCK_TEXT_CHARS ? `${text.slice(0, BLOCK_TEXT_CHARS - 1)}…` : text;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The verified claims of the Research reports attached to the draft, one
 * line each (`R1.3 · claim · source title · url`). Empty when none.
 */
export function draftResearchSection(material: readonly ResearchMaterial[] | null | undefined): string {
  const reports = (material ?? []).filter((report) => report.claims.length > 0);
  if (reports.length === 0) return '';
  const lines = ['Verified facts from research reports (id · claim · source title · url):'];
  for (const report of reports) {
    lines.push(`Report: ${report.question.trim()}`);
    for (const claim of report.claims) {
      const title = claim.sourceTitle?.trim() || hostOf(claim.url);
      lines.push(`${claim.id} · ${claim.claim.replace(/\s+/g, ' ').trim()} · ${title} · ${claim.url}`);
    }
  }
  if (reports.some((report) => report.truncated)) {
    lines.push('Some claims were left out to keep this list short.');
  }
  lines.push(
    'Prefer these facts; cite each one you use with an inline link to its URL. They were checked against their sources.',
  );
  return lines.join('\n');
}

/**
 * Per-turn developer prompt: where the draft stands right now. Small on
 * purpose (one line per block, its id, owner and the start of its text) so a
 * long draft fits a local model's context; read_draft fetches full text.
 * `research` is the material of the Research reports attached to the draft.
 */
export function draftDeveloperPrompt(draft: DraftDetail, research?: readonly ResearchMaterial[] | null): string {
  const lines: string[] = [`Draft "${draft.title}" · stage: ${draft.stage} · ${draft.words} words.`];
  const brief = draft.brief.trim();
  lines.push(brief ? `Brief: ${brief}` : 'Brief: none given.');
  if (draft.outline.length > 0) {
    lines.push('Outline:');
    draft.outline.forEach((section, i) => {
      const words = section.targetWords != null ? ` (~${section.targetWords} words)` : '';
      const intent = section.intent.trim() ? ` — ${section.intent.trim()}` : '';
      lines.push(`${i + 1}. ${section.heading}${words}${intent}`);
    });
  } else {
    lines.push('Outline: none yet.');
  }
  if (draft.blocks.length > 0) {
    lines.push('Blocks (block_id · owner · pinned · text):');
    for (const block of draft.blocks.slice(0, MAX_LISTED_BLOCKS)) {
      lines.push(
        `${block.id} · ${block.owner} · ${block.pinned ? 'pinned' : '-'} · ${blockText(draft.markdown, block.start, block.end)}`,
      );
    }
    if (draft.blocks.length > MAX_LISTED_BLOCKS) {
      lines.push(`… ${draft.blocks.length - MAX_LISTED_BLOCKS} more blocks; use read_draft to see them.`);
    }
  } else {
    lines.push('Blocks: none yet (the draft is empty).');
  }
  if (draft.stage === 'outline') {
    lines.push(
      draft.outline.length === 0
        ? 'Next step: propose the outline with set_outline from the brief. If the brief does not say who it is for, how long it should be or the tone, state your guess in your reply. Then ask the user to review the outline in the panel.'
        : 'The user is reviewing the outline. Revise it with set_outline if they ask; the draft is written after they press "Approve outline".',
    );
  }
  const facts = draftResearchSection(research);
  if (facts) lines.push(facts);
  return lines.join('\n');
}
