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
    "add_slide takes a layout and that layout's fields, listed below; the app builds the slide from them and checks the limits. If a call is rejected, fix exactly what the error names and call again.",
    "For changes, touch only what was asked. For a word change, use update_slots: it sets the text of named slots, on one slide or on several at once. To restructure a slide, use update_slide with its slide_id and only the fields that change: the rest is kept, null removes an optional field, and a new layout needs that layout's fields. replace_in_deck swaps an exact word or phrase everywhere. patch_slide is only for custom slides and older slides without fields. move_slide and delete_slide change the order. read_deck with a slide_id shows a slide's fields; use it before changing a slide you have not seen in full. Use set_theme only when the user asks to change the look of the whole deck.",
    'Text the user wrote themselves is pinned (the outline marks it; in slide HTML its element carries data-owner="user"). Keep pinned text exactly as it is; update_slide keeps it for you. Change it only when the user names that text ("change my headline", "fix the −45%"), and then pass its slot name in release_pinned. "Rewrite this slide", "make it punchier" or "redo the deck" do not name it: keep it word for word and mention in your reply that you kept the user\'s text.',
    THEME_CONTRACT,
    'The theme sets every size: text, numbers and charts cannot be made bigger directly. To make something stand out or read larger, remove what competes with it (fewer stats or categories, shorter labels, drop a kicker or footnote) or move it to a layout that gives it more room (statement, stat-row with fewer stats, chart). Say plainly in your reply what changed, and if nothing could change, say so.',
    "Use only figures the user gave you or that came from a source in this chat. When a slide needs numbers you do not have, say so in your reply; if the user asked for an example deck, mark the numbers as placeholders in the footnote. Units belong to what is measured: a score is not \"M\".",
    'After your turn the app checks how the slides you changed render. If text is too dense, overlaps or is cut off, or a drawing is unreadable, it sends you one "Layout check" message: fix only what it lists.',
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
