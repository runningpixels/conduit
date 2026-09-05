import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsSection } from './SkillsSection';

const {
  listSkills,
  importSkillFolder,
  importSkillZip,
  revealSkillsDir,
  deleteManagedSkill,
  exportSkillFolder,
  exportSkillZip,
} = vi.hoisted(() => ({
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

  it('lists discovered packages including ~/.claude/skills without copying', async () => {
    render(<SkillsSection onStatus={vi.fn()} />);
    expect(await screen.findByText('pdf-processing')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('scripts unused')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('imports a folder into the Conduit skills dir', async () => {
    const onStatus = vi.fn();
    render(<SkillsSection onStatus={onStatus} />);
    await screen.findByText('pdf-processing');
    fireEvent.click(screen.getByRole('button', { name: 'Import folder' }));
    await waitFor(() => {
      expect(importSkillFolder).toHaveBeenCalled();
    });
  });
});
