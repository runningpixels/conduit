import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationFolder, KnowledgeCollection, SkillSummary } from '../ipc/contracts';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';

const ipc = vi.hoisted(() => ({
  getProjectSettings: vi.fn(),
  setProjectSettings: vi.fn(),
  listKnowledgeCollections: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  listSkills: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const folder: ConversationFolder = { id: 'f1', name: 'Ferry', createdAt: '2026-10-01T00:00:00Z' };
const consented = { workspaceConsented: true, onAllowWorkspace: async () => {} };

function collection(id: string, name: string): KnowledgeCollection {
  return {
    id,
    name,
    providerId: 'openai',
    embeddingModel: 'm',
    embeddingDimensions: 4,
    documentCount: 2,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

function skill(id: string, name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id,
    name,
    description: `${name} skill`,
    source: 'managed',
    path: `/skills/${id}`,
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
    ...extra,
  } as SkillSummary;
}

beforeEach(() => {
  ipc.getProjectSettings.mockResolvedValue({
    folderId: 'f1',
    userInstructions: 'Use British English.',
    workspaceRoot: 'C:/ferry',
    skillIds: [],
    collectionIds: ['c1'],
  });
  ipc.listKnowledgeCollections.mockResolvedValue([collection('c1', 'Specs'), collection('c2', 'Notes')]);
  ipc.listSkills.mockResolvedValue([skill('conduit:pdf', 'PDF'), skill('bad', 'Broken', { parseError: 'no name' })]);
  ipc.setProjectSettings.mockImplementation(async (s) => s);
});
afterEach(() => vi.clearAllMocks());

describe('ProjectSettingsDialog', () => {
  it('shows the project’s settings and saves every part, keeping the working folder', async () => {
    const onSaved = vi.fn();
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={onSaved} />);
    const instructions = await screen.findByDisplayValue('Use British English.');
    expect(screen.getByRole('dialog', { name: 'Project settings: Ferry' })).toBeTruthy();
    // A skill that does not parse is not offered.
    expect(screen.queryByLabelText('Broken')).toBeNull();

    fireEvent.change(instructions, { target: { value: 'Answer briefly.' } });
    fireEvent.click(screen.getByLabelText('PDF'));
    fireEvent.click(screen.getByLabelText(/^Notes/));
    fireEvent.click(screen.getByLabelText(/^Specs/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(ipc.setProjectSettings).toHaveBeenCalledWith({
      folderId: 'f1',
      userInstructions: 'Answer briefly.',
      workspaceRoot: 'C:/ferry',
      skillIds: ['conduit:pdf'],
      collectionIds: ['c2'],
    });
  });

  it('saves blank instructions as none', async () => {
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(await screen.findByDisplayValue('Use British English.'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.setProjectSettings).toHaveBeenCalled());
    expect(ipc.setProjectSettings.mock.calls[0][0].userInstructions).toBeNull();
  });

  it('makes a collection named after the project and turns it on', async () => {
    ipc.createKnowledgeCollection.mockResolvedValue(collection('c3', 'Ferry'));
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={() => {}} />);
    await screen.findByDisplayValue('Use British English.');
    fireEvent.click(screen.getByRole('button', { name: 'New collection for this project' }));
    expect(await screen.findByText('Collection created. Add files to it in Documents.')).toBeTruthy();
    expect(ipc.createKnowledgeCollection).toHaveBeenCalledWith('Ferry');
    expect((screen.getByLabelText(/^Ferry/) as HTMLInputElement).checked).toBe(true);
  });

  it('shows why saving failed and stays open', async () => {
    ipc.setProjectSettings.mockRejectedValue(new Error('user instructions cannot exceed 32768 characters'));
    const onSaved = vi.fn();
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={onSaved} />);
    await screen.findByDisplayValue('Use British English.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot exceed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('puts focus in the instructions once the settings load', async () => {
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={() => {}} />);
    const instructions = await screen.findByDisplayValue('Use British English.');
    await waitFor(() => expect(document.activeElement).toBe(instructions));
  });

  it('picks a working folder and saves it', async () => {
    ipc.pickWorkspaceFolder.mockResolvedValue('D:/ferry-app');
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText('C:/ferry')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByText('D:/ferry-app')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.setProjectSettings).toHaveBeenCalled());
    expect(ipc.setProjectSettings.mock.calls[0][0].workspaceRoot).toBe('D:/ferry-app');
  });

  it('removes the working folder', async () => {
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove folder' }));
    expect(screen.getByText('No working folder.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.setProjectSettings).toHaveBeenCalled());
    expect(ipc.setProjectSettings.mock.calls[0][0].workspaceRoot).toBeNull();
  });

  it('asks for the workspace consent before the first folder pick', async () => {
    ipc.pickWorkspaceFolder.mockResolvedValue('D:/ferry-app');
    const onAllowWorkspace = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ProjectSettingsDialog
        folder={folder}
        workspaceConsented={false}
        onAllowWorkspace={onAllowWorkspace}
        onClose={onClose}
        onSaved={() => {}}
      />,
    );
    await screen.findByDisplayValue('Use British English.');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(screen.getByRole('dialog', { name: 'Workspace tools consent' })).toBeTruthy();
    expect(ipc.pickWorkspaceFolder).not.toHaveBeenCalled();

    // Escape answers the question, not the whole dialog.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Workspace tools consent' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('D:/ferry-app')).toBeTruthy();
    expect(onAllowWorkspace).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ProjectSettingsDialog {...consented} folder={folder} onClose={onClose} onSaved={() => {}} />);
    await screen.findByDisplayValue('Use British English.');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
