import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../ipc/contracts';
import { LibraryPage } from './LibraryPage';

vi.mock('../ipc/client', () => ({
  listPrompts: vi.fn(),
  listPromptFolders: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
  listSkills: vi.fn(),
  importSkillFolder: vi.fn(),
  importSkillZip: vi.fn(),
  revealSkillsDir: vi.fn(),
  deleteManagedSkill: vi.fn(),
  exportSkillFolder: vi.fn(),
  exportSkillZip: vi.fn(),
}));

import { listPromptFolders, listPrompts, listSkills } from '../ipc/client';

const settings = { workspaceRoot: '/ws' } as AppSettings;

function renderPage(initialTab?: 'prompts' | 'skills', onInsertPrompt = vi.fn()) {
  render(<LibraryPage settings={settings} onStatus={vi.fn()} onInsertPrompt={onInsertPrompt} initialTab={initialTab} />);
  return onInsertPrompt;
}

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPrompts).mockResolvedValue([
      {
        id: 'p1',
        title: 'Summarise',
        body: 'Summarise the thread.',
        variables: [],
        tags: [],
        sortOrder: 0,
        createdAt: '2026-09-17T00:00:00Z',
      },
    ]);
    vi.mocked(listPromptFolders).mockResolvedValue([]);
    vi.mocked(listSkills).mockResolvedValue([
      {
        id: 'conduit:demo',
        name: 'demo',
        description: 'A managed skill',
        source: 'conduit',
        path: '/data/skills/demo',
        hasScripts: false,
        hasReferences: false,
        hasAssets: false,
      },
    ]);
  });

  it('is a page titled Library with Prompts and Skills tabs', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 2, name: 'Library' })).toBeInTheDocument();
    const prompts = screen.getByRole('tab', { name: 'Prompts' });
    expect(prompts).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', prompts.id);
    await screen.findByRole('heading', { name: 'Summarise' });
  });

  it("puts the prompts tab's main action in the header and inserts the selected prompt", async () => {
    const onInsert = renderPage();
    await screen.findByRole('heading', { name: 'Summarise' });
    expect(screen.getByRole('button', { name: 'New prompt' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Insert into chat' }));
    expect(onInsert).toHaveBeenCalledWith('Summarise the thread.');
  });

  it('switches to skills, whose main action is importing', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'demo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import folder' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New prompt' })).toBeNull();
  });

  it('moves between tabs with the arrow keys and keeps focus on the tab', async () => {
    renderPage();
    const prompts = screen.getByRole('tab', { name: 'Prompts' });
    prompts.focus();
    fireEvent.keyDown(prompts, { key: 'ArrowRight' });
    const skills = await screen.findByRole('tab', { name: 'Skills', selected: true });
    await waitFor(() => expect(skills).toHaveFocus());
    expect(screen.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('tabindex', '-1');
  });

  it('opens on the tab it is given', async () => {
    renderPage('skills');
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'demo' })).toBeInTheDocument();
  });

  it('shows the empty state in the detail pane when there are no prompts', async () => {
    vi.mocked(listPrompts).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Save a prompt once, then insert it into any chat.')).toBeInTheDocument();
  });
});
