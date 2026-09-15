import { describe, expect, it } from 'vitest';
import { classifyDocumentTurnIntent, type DocumentTurnIntent } from './documentTurnIntent';

/**
 * Labeled prompts for document routing. Real prompts from use sit next to the
 * adversarial ones; when routing changes, this table is what it is judged by.
 *
 * `create` gets write/edit document tools; `edit` gets edit tools; `info` and
 * `general` get neither. A prompt that wrongly lands in `general` cannot
 * produce a document at all, which is the failure this table exists to catch.
 */
const CORPUS: Array<[prompt: string, expected: DocumentTurnIntent]> = [
  // Misrouted in live testing: no "artifact", so no document tools.
  ['Create an HTML document titled Solar System Field Guide, with a styled card for each of the eight planets.', 'create'],
  ['make a one-pager about our Q3 roadmap', 'create'],
  ['build me a landing page for a bakery', 'create'],
  ['write a report on renewable energy adoption in Europe', 'create'],
  ['draft a cheat sheet for git rebase', 'create'],
  ['generate a markdown guide to our onboarding process', 'create'],
  ['put together a web page comparing three laptops', 'create'],
  ['design an infographic about sleep cycles', 'create'],
  ['can you create an html page for my portfolio?', 'create'],

  // Already routed correctly before; must stay that way.
  ['create a new html artifact of the history of japan', 'create'],
  ['create an artifact highlighting the history of books', 'create'],
  ['create a new html artifact: a simple pancake recipe card', 'create'],
  ['artifact html please', 'create'],

  // Edit follow-ups.
  ['update the artifact: add a toppings section with 4 ideas below the steps', 'edit'],
  ['make it dark mode', 'edit'],
  ['could you remove the footer?', 'edit'],

  // Informational: explanations, not documents.
  ['what is an html document?', 'info'],
  ['how do I write a good report?', 'info'],
  ['how do I create a landing page in React?', 'info'],
  ['what types of documents can you create?', 'info'],
  // No question prefix the info check knows, so `general` — equally tool-free.
  ['explain how markdown works', 'general'],

  // Plain chat and writing with no document noun.
  ['history of mexico', 'general'],
  ['overview of philosophy', 'general'],
  ['write a poem about autumn', 'general'],
  ['draft an email to my landlord', 'general'],
  ['hello', 'general'],
];

describe('document routing corpus', () => {
  it.each(CORPUS)('%s → %s', (prompt, expected) => {
    expect(classifyDocumentTurnIntent(prompt)).toBe(expected);
  });
});
