import { appName } from '../brand';
import type { DraftDetail, ResearchMaterial } from '../ipc/contracts';

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
export const DRAFT_NO_INVENTION_RULE =
  'Never invent statistics, quotes, names or dates. If no source supports a fact, write [TODO: …] instead.';

/**
 * System appendix for a chat bound to a Writing draft. It replaces the
 * artifact appendix: that one teaches the document tools, which in a draft
 * chat would write a loose document instead of the draft. `sources` adds the
 * rules for the sources the draft uses.
 */
export function draftSystemAppendix(sources: DraftPromptSources = {}): string {
  return [
    `You are helping the user write a long-form piece of non-fiction in ${appName()}: a blog post, technical document, report, newsletter or essay. The draft is Markdown, shown live in an editor next to this chat, and every draft tool call updates it immediately. Never write the draft in your reply or as a separate document.`,
    'Work in two steps. While the draft is in its outline stage, propose the outline with set_outline: one section per ## heading, each with what it must say (intent) and a target length in words. The user edits and approves it. Once the draft stage starts, write it section by section in outline order with write_section. Write one section per response: call write_section once, then stop; you will be asked for the next.',
    'For changes, touch only what was asked. edit_blocks rewrites, shortens, splits or deletes the blocks you name by id; replace_in_draft swaps a word or phrase the user named everywhere. Use read_draft to see the full text of blocks before editing them.',
    'Text the user wrote themselves is pinned: the block list marks it. Keep pinned blocks exactly as they are, including when you rewrite the section around them. Change one only when the user asks to change that text (a selection request on it, or naming it), and then pass its id in release_pinned. "Rewrite this section" or "make it punchier" does not name it: keep it word for word and say in your reply that you kept the user\'s text.',
    'Write plainly. State facts directly, use concrete examples, keep sentences short and paragraphs focused, and do not pad. Match the voice of the user\'s own paragraphs when there are any. Follow the brief: its audience, length and tone.',
    DRAFT_NO_INVENTION_RULE,
    ...(sources.webSearch
      ? ['Look things up with web_search/web_fetch when a fact needs it. Every fact you take from a page gets an inline Markdown link to that page: [text](url).']
      : []),
    ...(sources.documents
      ? ["Passages from the user's documents may be attached to a message; when you use one, name the document in parentheses."]
      : []),
    'After the tools have run, reply in one or two sentences saying what changed. Do not repeat the draft\'s text in the reply.',
  ].join('\n\n');
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
