/**
 * The panel for a chat that has artifacts: a list of them when none is open
 * (not the generic "Artifacts live here" card), and a header switcher between
 * them while one is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { Artifact } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
  revealPath: vi.fn().mockResolvedValue(undefined),
  parseBrandSource: vi.fn().mockRejectedValue(new Error('not a brand')),
  setBrandConfig: vi.fn(),
  artifactPrincipal: (id: string) => `artifact:${id}`,
}));

afterEach(() => {
  cleanup();
});

function artifact(id: string, title: string, createdAt: string, kind: Artifact['kind'] = 'markdown'): Artifact {
  return {
    id,
    conversationId: 'c1',
    kind,
    title,
    createdAt,
    mimeType: 'text/markdown',
    contentText: `# ${title}`,
    sizeBytes: 2048,
  };
}

const oldest = artifact('a1', 'Plan', '2026-10-01T00:00:00Z');
const middle = artifact('a2', 'Budget', '2026-10-02T00:00:00Z', 'json');
const newest = artifact('a3', 'Report', '2026-10-03T00:00:00Z');
const chat = [oldest, middle, newest];

const required = {
  fileStateMap: {},
  activeFileState: 'noFileContent' as const,
  allowlist: [],
  docTab: 'preview' as const,
  onSelectTab: vi.fn(),
  onSaveContent: vi.fn(),
  onExport: vi.fn(),
};

/** The panel wired the way App wires it: open ids, the active one, closing. */
function Harness({
  artifacts,
  initialOpen = null,
  onRename,
}: {
  artifacts: Artifact[];
  initialOpen?: string | null;
  onRename?: (id: string, title: string) => void;
}) {
  const [openIds, setOpenIds] = useState<string[]>(initialOpen ? [initialOpen] : []);
  const [activeId, setActiveId] = useState<string | null>(initialOpen);
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const active = activeId ? byId.get(activeId) ?? null : null;
  return (
    <DocumentPanel
      {...required}
      artifact={active}
      openArtifacts={openIds.map((id) => byId.get(id)!).filter(Boolean)}
      chatArtifacts={artifacts}
      onOpenArtifact={(id) => {
        setOpenIds((current) => (current.includes(id) ? current : [...current, id]));
        setActiveId(id);
      }}
      onSwitchArtifact={(id) => {
        setOpenIds((current) => current.map((x) => (x === activeId ? id : x)));
        setActiveId(id);
      }}
      onShowArtifactList={() => {
        setOpenIds([]);
        setActiveId(null);
      }}
      onCloseTab={(id) => {
        const rest = openIds.filter((x) => x !== id);
        setOpenIds(rest);
        setActiveId(rest.length > 0 ? rest[rest.length - 1] : null);
      }}
      onRenameArtifact={onRename}
    />
  );
}

describe('DocumentPanel: the chat artifact list', () => {
  it('lists the chat artifacts, newest first, when none is open', () => {
    render(<Harness artifacts={chat} />);
    expect(screen.queryByText('Artifacts live here')).toBeNull();
    expect(screen.getByRole('heading', { name: 'In this chat' })).toBeInTheDocument();
    expect(screen.getByText('3 artifacts')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Artifacts in this chat' });
    const names = within(list)
      .getAllByRole('listitem')
      .map((row) => row.querySelector('.artifact-list-name')?.textContent);
    expect(names).toEqual(['Report', 'Budget', 'Plan']);
    // Kind and size, from the same helpers the chat's cards use.
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('JSON · 2 kB');
  });

  it('says "1 artifact" for one', () => {
    render(<Harness artifacts={[oldest]} />);
    expect(screen.getByText('1 artifact')).toBeInTheDocument();
  });

  it('opens an artifact from its row', () => {
    render(<Harness artifacts={chat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Budget' }));
    expect(screen.queryByRole('list', { name: 'Artifacts in this chat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Budget' })).toBeInTheDocument();
  });

  it('returns to the list, not the empty state, when the artifact is closed', () => {
    render(<Harness artifacts={chat} initialOpen="a2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Budget' }));
    expect(screen.getByRole('list', { name: 'Artifacts in this chat' })).toBeInTheDocument();
    expect(screen.queryByText('Artifacts live here')).toBeNull();
  });

  it('keeps the old empty state for a chat without artifacts', () => {
    render(<Harness artifacts={[]} />);
    expect(screen.getByText('Artifacts live here')).toBeInTheDocument();
    expect(screen.queryByText('In this chat')).toBeNull();
  });

  it('keeps the old empty state outside a chat (no chatArtifacts)', () => {
    render(<DocumentPanel {...required} artifact={null} openArtifacts={[]} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText('Artifacts live here')).toBeInTheDocument();
  });
});

describe('DocumentPanel: the header switcher', () => {
  function trigger() {
    return screen.getByRole('button', { name: /Budget/, expanded: false });
  }

  it('is a plain title when the chat has one artifact', () => {
    render(<Harness artifacts={[oldest]} initialOpen="a1" />);
    expect(screen.queryByRole('button', { name: /Plan/, expanded: false })).toBeNull();
    expect(document.querySelector('.doc-title b')).toHaveTextContent('Plan');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the title, its position and a listbox of the chat artifacts', () => {
    render(<Harness artifacts={chat} initialOpen="a2" />);
    const button = trigger();
    expect(button).toHaveAttribute('aria-haspopup', 'listbox');
    expect(button).toHaveTextContent('2 of 3');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: 'Artifacts in this chat' });
    const options = within(listbox).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Report'),
      expect.stringContaining('Budget'),
      expect.stringContaining('Plan'),
      'All artifacts in this chat',
    ]);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('selects another artifact with a click', () => {
    render(<Harness artifacts={chat} initialOpen="a2" />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Plan/ }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Plan/, expanded: false })).toHaveTextContent('3 of 3');
    // Shown in place: still one artifact open, not a tab strip.
    expect(document.querySelector('.artifact-tabs')).toBeNull();
  });

  it('moves with the arrow keys and picks with Enter', () => {
    render(<Harness artifacts={chat} initialOpen="a2" />);
    const button = trigger();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const listbox = screen.getByRole('listbox');
    expect(document.activeElement).toBe(listbox);
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /Report/, expanded: false })).toHaveTextContent('1 of 3');
  });

  it('"All artifacts in this chat" returns to the list', () => {
    render(<Harness artifacts={chat} initialOpen="a2" />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: 'All artifacts in this chat' }));
    expect(screen.getByRole('list', { name: 'Artifacts in this chat' })).toBeInTheDocument();
  });

  it('closes the list on Escape without closing the artifact', () => {
    const bubbled = vi.fn();
    document.addEventListener('keydown', bubbled);
    try {
      render(<Harness artifacts={chat} initialOpen="a2" />);
      const button = trigger();
      fireEvent.click(button);
      const listbox = screen.getByRole('listbox');
      fireEvent.keyDown(listbox, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(bubbled).not.toHaveBeenCalled();
      // The artifact is still open, and focus is back on the switcher.
      expect(screen.getByRole('button', { name: 'Close Budget' })).toBeInTheDocument();
      expect(document.activeElement).toBe(button);
    } finally {
      document.removeEventListener('keydown', bubbled);
    }
  });

  it('keeps rename reachable beside the switcher', () => {
    const onRename = vi.fn();
    render(<Harness artifacts={chat} initialOpen="a2" onRename={onRename} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Budget' }));
    const input = screen.getByDisplayValue('Budget');
    fireEvent.change(input, { target: { value: 'Costs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('a2', 'Costs');
  });

  it('sits beside the tab strip when several are open, and opens a tab', () => {
    const onOpenArtifact = vi.fn();
    render(
      <DocumentPanel
        {...required}
        artifact={middle}
        openArtifacts={[oldest, middle]}
        chatArtifacts={chat}
        onOpenArtifact={onOpenArtifact}
        onSwitchArtifact={vi.fn()}
        onShowArtifactList={vi.fn()}
      />,
    );
    expect(document.querySelector('.artifact-tabs')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts in this chat' }));
    fireEvent.click(screen.getByRole('option', { name: /Report/ }));
    expect(onOpenArtifact).toHaveBeenCalledWith('a3');
  });
});
