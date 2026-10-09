import { describe, expect, it } from 'vitest';
import en from '../i18n/messages/en.json';
import { classifyDocumentTurnIntent } from '../chat/documentTurnIntent';
import { looksLikeImageGenerationRequest } from '../chat/imageGenerationPrompt';
import { userWantsWebSearch } from '../chat/webSearchIntent';
import { mentionsWorkspaceFileTarget, selectBuiltinTurnTools } from '../chat/agentTools';
import de from '../i18n/messages/de.json';
import { CAPABILITIES, IDEA_CATEGORIES, IDEAS, IDEAS_REVISION } from './catalog';

const messages = en as Record<string, string>;

describe('ideas catalog', () => {
  it('has unique ids, known categories and needs, and a sane revision', () => {
    expect(new Set(IDEAS.map((i) => i.id)).size).toBe(IDEAS.length);
    for (const idea of IDEAS) {
      expect(IDEA_CATEGORIES).toContain(idea.category);
      for (const need of idea.needs) expect(CAPABILITIES).toContain(need);
      expect(idea.addedIn).toBeGreaterThan(0);
      expect(idea.addedIn).toBeLessThanOrEqual(IDEAS_REVISION);
      // Absent until the live battery has passed this prompt; never a placeholder.
      if (idea.verified) expect(idea.verified.on, idea.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('marks ideas added in this revision as new', () => {
    expect(IDEAS.some((i) => i.addedIn === IDEAS_REVISION)).toBe(true);
  });

  it('has a title, blurb and prompt for every idea, and a label for every category', () => {
    for (const idea of IDEAS) {
      for (const part of ['title', 'blurb', 'prompt']) {
        expect(messages[`ideas.item.${idea.id}.${part}`], `${idea.id}.${part}`).toBeTruthy();
      }
    }
    for (const c of ['all', ...IDEA_CATEGORIES]) expect(messages[`ideas.category.${c}`]).toBeTruthy();
    for (const c of CAPABILITIES) {
      expect(messages[`ideas.badge.${c}`]).toBeTruthy();
      expect(messages[`ideas.setup.${c}`]).toBeTruthy();
    }
  });

  // Live, 2026-09-26: "Build me a currency converter…" did not read as a
  // document request, so the model had no document tools, called one anyway,
  // and the reply was one sentence. Every page idea must reach the tools.
  it('routes every page idea to the document tools', () => {
    for (const idea of IDEAS.filter((i) => i.page)) {
      const prompt = messages[`ideas.item.${idea.id}.prompt`];
      expect(classifyDocumentTurnIntent(prompt), `${idea.id}: ${prompt}`).toBe('create');
    }
  });

  // A deck idea used to be a page idea, so the chat built one HTML file
  // instead of a deck. Deck ideas open in Slides and are never page ideas.
  it('sends deck ideas to Slides, not the document tools', () => {
    const decks = IDEAS.filter((i) => i.opens === 'slides');
    expect(decks.map((i) => i.id)).toContain('pitchDeck');
    for (const idea of decks) expect(idea.page, idea.id).toBe(false);
  });

  it('routes each need to the tool that serves it', () => {
    for (const idea of IDEAS) {
      const prompt = messages[`ideas.item.${idea.id}.prompt`];
      if (idea.needs.includes('imageGen')) expect(looksLikeImageGenerationRequest(prompt), idea.id).toBe(true);
      if (idea.needs.includes('webSearch')) expect(userWantsWebSearch(prompt), idea.id).toBe(true);
      if (idea.needs.includes('workspace')) expect(mentionsWorkspaceFileTarget(prompt), idea.id).toBe(true);
    }
  });

  it('routes the dashboard and flashcards chips to the document tools', () => {
    for (const chip of ['dashboard', 'flashcards']) {
      expect(classifyDocumentTurnIntent(messages[`ideas.chip.${chip}.text`]), chip).toBe('create');
    }
  });

  // The intent checks read English only, so a translated prompt would miss its
  // tools; a chat started from an idea passes the idea's needs instead
  // (ChatView.handleSend → selectBuiltinTurnTools).
  it('gives a translated idea its tools through the idea, not the wording', () => {
    const msgs = de as Record<string, string>;
    const settings = { memoryEnabled: false, activeProvider: 'openai', imageGenerationConsentAcknowledged: true };
    const page = msgs['ideas.item.snakeGame.prompt'];
    expect(classifyDocumentTurnIntent(page)).not.toBe('create'); // why the hint exists
    const pageTools = selectBuiltinTurnTools(page, settings, null, 'create').tools.map((t) => t.name);
    expect(pageTools.some((n) => /^write_\w+_document$/.test(n))).toBe(true);
    const logo = msgs['ideas.item.bakeryLogo.prompt'];
    const imageTools = selectBuiltinTurnTools(logo, settings, null, undefined, true).tools.map((t) => t.name);
    expect(imageTools).toContain('generate_image');
  });
});
