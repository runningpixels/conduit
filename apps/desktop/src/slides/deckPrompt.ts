import { appName } from '../brand';
import type { DeckDetail } from '../ipc/contracts';
import { THEME_CONTRACT } from './themes';

/** Longest slide text the outline carries per slide; read_deck returns the rest. */
const OUTLINE_TEXT_CHARS = 120;

/**
 * System appendix for a chat bound to a deck. It replaces the artifact
 * appendix: that one teaches `write_html_document`, which in a deck chat
 * would produce a loose document instead of a slide.
 */
export function deckSystemAppendix(): string {
  return [
    `You are editing a slide deck in ${appName()}. The deck is shown live next to this chat, and every slide tool call updates it immediately. Never write the deck as a document or as HTML in your reply.`,
    'Work in two steps. While the deck is in its storyline stage, propose one line per slide with set_storyline: the point each slide makes, in story order. The user edits and approves it. Once slides are being built, make each slide with add_slide, one slide per call, in storyline order.',
    'For changes, touch only what was asked: patch_slide for a word or phrase, update_slide to rewrite one slide, move_slide and delete_slide for order. Use read_deck with a slide_id before patching a slide you have not seen in full. Use set_theme only when the user asks to change the look of the whole deck.',
    'For changes across slides: replace_in_deck swaps an exact word or phrase everywhere; update_slots sets the text of named slots on several slides at once, for edits that need judgment (wording, case, tone).',
    'Text the user wrote themselves is pinned (its element carries data-owner="user", and the outline marks it). Keep pinned text exactly as it is, including when you rewrite the rest of the slide. Change it only when the user names that text, and then pass its slot name in release_pinned.',
    THEME_CONTRACT,
    'Rules for slide HTML: send the inner HTML only, without a <section> wrapper. Put every piece of visible text in an element with a data-text attribute naming its slot (data-text="headline", data-text="point-1"). Take colors and fonts from the theme classes and tokens, never hard-coded values. No scripts and no external URLs: draw charts and diagrams as inline SVG. Keep slides sparse: a slide is read from across a room.',
    'After the tools have run, reply in one or two sentences saying what changed. Do not repeat slide content in the reply.',
  ].join('\n\n');
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
 */
export function deckDeveloperPrompt(deck: DeckDetail, overflow: Record<string, number> = {}): string {
  const lines: string[] = [`Deck "${deck.title}" · theme ${deck.themeName} · stage: ${deck.stage}.`];
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
      const px = overflow[slide.id] ?? 0;
      if (px > 0) notes.push(`text overflows the slide by ${px}px; shorten or split it if you touch this slide`);
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
        ? 'Next step: draft the storyline with set_storyline from what the user has told you, then ask them to review it in the panel.'
        : 'The user is reviewing the storyline. Revise it with set_storyline if they ask; slides are built after they press "Build slides".',
    );
  }
  return lines.join('\n');
}
