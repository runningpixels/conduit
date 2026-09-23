import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { KnowledgeCitation, KnowledgePassage } from '../ipc/contracts';

const getKnowledgePassage = vi.fn<(chunkId: string) => Promise<KnowledgePassage | null>>();
vi.mock('../ipc/client', () => ({
  getKnowledgePassage: (chunkId: string) => getKnowledgePassage(chunkId),
}));

const { KnowledgeCitations } = await import('./KnowledgeCitations');

function cite(chunkId: string, ordinal: number, documentId = 'd1', title = 'greenhouse.md'): KnowledgeCitation {
  return { documentId, documentTitle: title, chunkId, ordinal, charStart: 0, charEnd: 10 };
}

function passage(chunkId: string, ordinal: number, content: string): KnowledgePassage {
  return {
    chunkId,
    documentId: 'd1',
    documentTitle: 'greenhouse.md',
    source: 'C:/garden/greenhouse.md',
    mimeType: 'text/markdown',
    ordinal,
    documentChunkCount: 12,
    charStart: 0,
    charEnd: content.length,
    content,
  };
}

describe('KnowledgeCitations', () => {
  beforeEach(() => getKnowledgePassage.mockReset());

  /** t1-6 criterion 1 wants the document *and location* in the thread. The
   *  first version showed a name and an excerpt count only. */
  it('names the sections each document was cited from, 1-based', () => {
    render(<KnowledgeCitations citations={[cite('a', 6), cite('b', 2), cite('c', 0, 'd2', 'inventory.csv')]} />);
    expect(screen.getByRole('button', { name: /greenhouse\.md · sections 3, 7/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /inventory\.csv · section 1/ })).toBeTruthy();
  });

  it('opens the passage as plain text, and switches between cited sections', async () => {
    getKnowledgePassage.mockImplementation(async (id) =>
      id === 'a' ? passage('a', 6, 'Clean the <b>limit switch</b>.') : passage('b', 2, 'Water every second day.'),
    );
    render(<KnowledgeCitations citations={[cite('a', 6), cite('b', 2)]} />);

    fireEvent.click(screen.getByRole('button', { name: /greenhouse\.md/ }));
    // The best-ranked citation opens first, whatever its position in the file.
    expect(await screen.findByText('Clean the <b>limit switch</b>.')).toBeTruthy();
    expect(screen.getByText('Section 7 of 12')).toBeTruthy();
    // File content is text, never markup: the tags stay literal.
    expect(document.querySelector('.kb-passage-text b')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Section 3' }));
    expect(await screen.findByText('Water every second day.')).toBeTruthy();
  });

  it('says so when the document has been deleted since the answer', async () => {
    getKnowledgePassage.mockResolvedValue(null);
    render(<KnowledgeCitations citations={[cite('a', 0)]} />);
    fireEvent.click(screen.getByRole('button', { name: /greenhouse\.md/ }));
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
  });

  it('closes on Escape', async () => {
    getKnowledgePassage.mockResolvedValue(passage('a', 0, 'text'));
    render(<KnowledgeCitations citations={[cite('a', 0)]} />);
    fireEvent.click(screen.getByRole('button', { name: /greenhouse\.md/ }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
