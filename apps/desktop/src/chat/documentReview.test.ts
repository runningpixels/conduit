import { describe, expect, it } from 'vitest';
import { createAppIntl, EN_MESSAGES, translate, type Translate } from '../i18n';
import { appPrompt, appPromptLabel } from './appPrompt';
import type { ChatTurn } from './conversationHydration';
import { requestForDocument, revisionMessage } from './documentReview';

const intl = createAppIntl('en', EN_MESSAGES);
const t: Translate = (id, values) => translate(intl, id, values);

const user = (id: string, content: string): ChatTurn => ({ id, role: 'user', content });
const reply = (id: string): ChatTurn => ({ id, role: 'assistant', content: 'Done.' });

describe('the request behind a document', () => {
  const turns = [
    user('u1', 'Write a heater email under 200 words.'),
    reply('a1'),
    user('u2', appPrompt('Check the layout', 'Fix the overflow')),
    user('u3', 'Now a 7-day running plan.'),
    reply('a2'),
  ];

  it('is what the user typed before the reply that made it', () => {
    expect(requestForDocument(turns, { sourceMessageId: 'a1' })).toBe('Write a heater email under 200 words.');
    expect(requestForDocument(turns, { sourceMessageId: 'a2' })).toBe('Now a 7-day running plan.');
  });

  it('skips notes the app sent, and falls back to the last typed words', () => {
    const afterNote = [user('u1', 'Minutes from these notes.'), user('n', appPrompt('Revise', 'x')), reply('a1')];
    expect(requestForDocument(afterNote, { sourceMessageId: 'a1' })).toBe('Minutes from these notes.');
    expect(requestForDocument(turns, { sourceMessageId: 'gone' })).toBe('Now a 7-day running plan.');
    expect(requestForDocument(turns, {})).toBe('Now a 7-day running plan.');
    expect(requestForDocument([reply('a1')], { sourceMessageId: 'a1' })).toBe('');
  });
});

describe('the revision message', () => {
  const review = {
    reviewer: 'Reviewer',
    issues: [
      { problem: 'It is 240 words', change: 'Cut it under 200' },
      { problem: 'October 8 is missing', change: '' },
    ],
  };

  it('shows a short note and gives the model the issues, the limits and the request', () => {
    const message = revisionMessage(t, review, 'Heater email', 'An email under 200 words.');
    expect(appPromptLabel(message)).toBe('Reviewer found 2 things to fix in “Heater email”');
    expect(message).toContain('Fix them by editing that document');
    expect(message).toContain('including its length limits, counts and sections');
    expect(message).toContain('1. It is 240 words — Cut it under 200\n2. October 8 is missing');
    expect(message).toContain('My request was:\nAn email under 200 words.');
  });

  it('leaves the request out when it is not known, and counts one thing', () => {
    const one = { reviewer: 'Strict editor', issues: [review.issues[0]] };
    const message = revisionMessage(t, one, 'Notes', '  ');
    expect(appPromptLabel(message)).toBe('Strict editor found 1 thing to fix in “Notes”');
    expect(message).not.toContain('My request was');
  });
});
