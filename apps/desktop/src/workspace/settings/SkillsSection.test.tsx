import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsSection } from './SkillsSection';

const {
  listSkills,
  importSkillFolder,
  importSkillZip,
  importSkillGit,
  revealSkillsDir,
  deleteManagedSkill,
  exportSkillFolder,
  exportSkillZip,
} = vi.hoisted(() => ({
  importSkillGit: vi.fn(),
  listSkills: vi.fn(),
  importSkillFolder: vi.fn(),
  importSkillZip: vi.fn(),
  revealSkillsDir: vi.fn(),
  deleteManagedSkill: vi.fn(),
  exportSkillFolder: vi.fn(),
  exportSkillZip: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  listSkills,
  importSkillGit,
  importSkillFolder,
  importSkillZip,
  revealSkillsDir,
  deleteManagedSkill,
  exportSkillFolder,
  exportSkillZip,
}));

describe('SkillsSection', () => {
  beforeEach(() => {
    listSkills.mockResolvedValue([
      {
        id: 'claude:pdf-processing',
        name: 'pdf-processing',
        description: 'Extract PDF text',
        source: 'claude',
        path: '/home/user/.claude/skills/pdf-processing',
        hasScripts: true,
        hasReferences: false,
        hasAssets: false,
      },
      {
        id: 'conduit:demo-skill',
        name: 'demo-skill',
        description: 'A Conduit-managed package',
        source: 'conduit',
        path: '/data/skills/demo-skill',
        hasScripts: false,
        hasReferences: false,
        hasAssets: false,
      },
    ]);
    importSkillFolder.mockResolvedValue({
      id: 'conduit:imported',
      name: 'imported',
      description: 'Imported',
      source: 'conduit',
      path: '/data/skills/imported',
      hasScripts: false,
      hasReferences: false,
      hasAssets: false,
    });
    importSkillZip.mockResolvedValue(null);
    revealSkillsDir.mockResolvedValue('/data/skills');
    deleteManagedSkill.mockResolvedValue(undefined);
    exportSkillFolder.mockResolvedValue('/tmp/pdf-processing');
    exportSkillZip.mockResolvedValue('/tmp/pdf-processing.zip');
  });

  it('lists discovered packages grouped by source, including ~/.claude/skills without copying', async () => {
    render(<SkillsSection onStatus={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /pdf-processing/ })).toBeInTheDocument();
    // Group headings: the managed folder first, then Claude.
    const groups = Array.from(document.querySelectorAll('.page-list-group')).map((g) => g.textContent);
    expect(groups).toEqual(['Conduit', 'Claude']);
  });

  it('selects the first skill and shows its detail; delete only for managed skills', async () => {
    render(<SkillsSection onStatus={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'demo-skill' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demo-skill/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('/data/skills/demo-skill')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pdf-processing/ }));
    expect(screen.getByRole('heading', { name: 'pdf-processing' })).toBeInTheDocument();
    expect(screen.getByText('scripts unused')).toBeInTheDocument();
    expect(screen.getByText('/home/user/.claude/skills/pdf-processing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('exports the selected skill as a folder and as a zip', async () => {
    const onStatus = vi.fn();
    render(<SkillsSection onStatus={onStatus} workspaceRoot="/ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /pdf-processing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export folder' }));
    await waitFor(() =>
      expect(exportSkillFolder).toHaveBeenCalledWith('claude:pdf-processing', 'Export skill to folder', '/ws'),
    );
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Exported pdf-processing'));
    fireEvent.click(screen.getByRole('button', { name: 'Export zip' }));
    await waitFor(() => expect(exportSkillZip).toHaveBeenCalled());
  });

  it('deletes a managed skill after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SkillsSection onStatus={vi.fn()} />);
    await screen.findByRole('heading', { name: 'demo-skill' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(deleteManagedSkill).toHaveBeenCalledWith('conduit:demo-skill'));
    confirm.mockRestore();
  });

  it('imports a folder into the Conduit skills dir', async () => {
    const onStatus = vi.fn();
    render(<SkillsSection onStatus={onStatus} />);
    await screen.findByRole('heading', { name: 'demo-skill' });
    fireEvent.click(screen.getByRole('button', { name: 'Import folder' }));
    await waitFor(() => {
      expect(importSkillFolder).toHaveBeenCalled();
    });
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Imported skill folder'));
  });

  it('imports a zip and opens the managed folder', async () => {
    render(<SkillsSection onStatus={vi.fn()} />);
    await screen.findByRole('heading', { name: 'demo-skill' });
    fireEvent.click(screen.getByRole('button', { name: 'Import zip' }));
    await waitFor(() => expect(importSkillZip).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Open .* folder/ }));
    await waitFor(() => expect(revealSkillsDir).toHaveBeenCalled());
  });

  it('shows the empty state with an import action when there are no skills', async () => {
    listSkills.mockResolvedValue([]);
    render(<SkillsSection onStatus={vi.fn()} />);
    expect(await screen.findByText('No skills yet', { selector: '.page-empty-title' })).toBeInTheDocument();
    // Header action + empty-state action.
    expect(screen.getAllByRole('button', { name: 'Import folder' })).toHaveLength(2);
  });

  it('imports a skill from a GitHub link, asking before it replaces one', async () => {
    const onStatus = vi.fn();
    const url = 'https://github.com/anthropics/skills/tree/main/skills/pdf';
    importSkillGit.mockReset();
    importSkillGit
      .mockRejectedValueOnce({ code: 'error.skills.exists', params: { name: 'pdf' }, fallback: 'A skill named "pdf" already exists.' })
      .mockResolvedValueOnce({
        id: 'conduit:pdf',
        name: 'pdf',
        description: 'PDF tools',
        source: 'conduit',
        path: '/data/skills/pdf',
        hasScripts: true,
        hasReferences: false,
        hasAssets: false,
      });
    render(<SkillsSection onStatus={onStatus} />);
    await screen.findByRole('heading', { name: 'demo-skill' });
    fireEvent.click(screen.getByRole('button', { name: 'Import from GitHub' }));
    expect(screen.getByText('Scripts in imported skills are never run.')).toBeInTheDocument();
    const field = screen.getByLabelText('GitHub link');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    fireEvent.change(field, { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(importSkillGit).toHaveBeenCalledWith(url, false));
    expect(await screen.findByText('A skill named pdf exists. Replace it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(importSkillGit).toHaveBeenLastCalledWith(url, true));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Imported pdf'));
    // The form closes once the skill is in.
    expect(screen.queryByLabelText('GitHub link')).toBeNull();
  });

  it('shows why a GitHub import failed, and cancelling the replace prompt keeps the form', async () => {
    importSkillGit.mockReset();
    importSkillGit
      .mockRejectedValueOnce('Only skills on github.com can be imported.')
      .mockRejectedValueOnce({ code: 'error.skills.exists', params: { name: 'pdf' }, fallback: 'exists' });
    render(<SkillsSection onStatus={vi.fn()} />);
    await screen.findByRole('heading', { name: 'demo-skill' });
    fireEvent.click(screen.getByRole('button', { name: 'Import from GitHub' }));
    fireEvent.change(screen.getByLabelText('GitHub link'), { target: { value: 'https://gitlab.com/a/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Only skills on github.com can be imported.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('A skill named pdf exists. Replace it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('A skill named pdf exists. Replace it?')).toBeNull();
    expect(screen.getByLabelText('GitHub link')).toBeInTheDocument();
    expect(importSkillGit).toHaveBeenCalledTimes(2);
  });

  it('offers the GitHub import in the empty state too', async () => {
    listSkills.mockResolvedValue([]);
    render(<SkillsSection onStatus={vi.fn()} />);
    await screen.findByText('No skills yet', { selector: '.page-empty-title' });
    expect(screen.getAllByRole('button', { name: 'Import from GitHub' })).toHaveLength(2);
  });
});
