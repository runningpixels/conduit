import { appName } from '../brand';
import type { DeckDetail } from '../ipc/contracts';
import deckSystemTemplate from '../prompts/deck-system.md?raw';
import { fillTemplate } from '../prompts/shared';
import { THEME_CONTRACT } from './themes';

/** Longest slide text the outline carries per slide; read_deck returns the rest. */
const OUTLINE_TEXT_CHARS = 120;

/**
 * System appendix for a chat bound to a deck. It replaces the artifact
 * appendix: that one teaches `write_html_document`, which in a deck chat
 * would produce a loose document instead of a slide.
 */
export function deckSystemAppendix(): string {
  return fillTemplate(deckSystemTemplate, appName(), { theme_contract: THEME_CONTRACT });
}

function outlineText(html: string): string {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > OUTLINE_TEXT_CHARS ? `${text.slice(0, OUTLINE_TEXT_CHARS - 1)}…` : text;
}

/**
 * Per-turn developer prompt: where the deck stands right now. Small on
 * purpose (ids, layouts and a line of text per slide) so a deck of any size
 * fits a local model's context; read_deck fetches a full slide on demand.
 * `layoutNotes` are the layout problems the deck frame measured, per slide id
 * (`layoutNotesBySlide`).
 */
export function deckDeveloperPrompt(deck: DeckDetail, layoutNotes: Record<string, string> = {}): string {
  const lines: string[] = [`Deck "${deck.title}" · theme ${deck.themeName} · stage: ${deck.stage}.`];
  if (deck.assumptions?.trim()) lines.push(`Assumptions you stated (the user can correct them): ${deck.assumptions.trim()}`);
  if (deck.storyline.length > 0) {
    lines.push('Storyline:');
    deck.storyline.forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));
  } else {
    lines.push('Storyline: none yet.');
  }
  if (deck.slides.length > 0) {
    lines.push('Slides (slide_id · layout · text):');
    for (const slide of deck.slides) {
      const notes: string[] = [];
      const pinned = (slide.slots ?? []).filter((slot) => slot.pinned).map((slot) => slot.name);
      if (pinned.length > 0) notes.push(`pinned: ${[...new Set(pinned)].join(', ')}`);
      const layout = layoutNotes[slide.id];
      if (layout) notes.push(`layout check: ${layout}`);
      lines.push(
        `${slide.position + 1}. ${slide.id} · ${slide.layout} · ${outlineText(slide.html)}` +
          (notes.length > 0 ? ` [${notes.join('; ')}]` : ''),
      );
    }
  } else {
    lines.push('Slides: none yet.');
  }
  if (deck.stage === 'storyline') {
    lines.push(
      deck.storyline.length === 0
        ? 'Next step: draft the storyline with set_storyline from what the user has told you. Give the deck a short title in the same call, and if the user did not say who it is for or what they should do afterwards, state your guess in assumptions. Then ask them to review the storyline in the panel.'
        : 'The user is reviewing the storyline. Revise it with set_storyline if they ask; slides are built after they press "Build slides".',
    );
  }
  return lines.join('\n');
}
