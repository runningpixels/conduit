import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerChatSettings } from './ComposerChatSettings';

function renderPopover(
  override: Parameters<typeof ComposerChatSettings>[0]['override'] = {},
  defaults: Parameters<typeof ComposerChatSettings>[0]['defaults'] = {},
) {
  const onSave = vi.fn();
  render(
    <ComposerChatSettings
      open
      streaming={false}
      defaults={defaults}
      override={override}
      onClose={() => {}}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe('ComposerChatSettings reasoning effort', () => {
  it('offers Auto plus each level the adapters map, with the reasoning-models hint', () => {
    renderPopover();
    const select = screen.getByLabelText(/Reasoning effort/) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Auto (model default)',
      'Low',
      'Medium',
      'High',
    ]);
    expect(screen.getByText(/Only reasoning models use it/)).toBeTruthy();
  });

  it('saves the chosen level with this chat', () => {
    const onSave = renderPopover();
    fireEvent.change(screen.getByLabelText(/Reasoning effort/), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save for this chat' }));
    expect(onSave).toHaveBeenCalledWith({ reasoningEffort: 'high' }, null);
  });

  it('shows the chat override and clears it back to Auto', () => {
    const onSave = renderPopover({ generationControls: { temperature: 0.5, reasoningEffort: 'low' } });
    const select = screen.getByLabelText(/Reasoning effort/) as HTMLSelectElement;
    expect(select.value).toBe('low');
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save for this chat' }));
    expect(onSave).toHaveBeenCalledWith({ temperature: 0.5 }, null);
  });

  it('starts from the Settings default when the chat has no override', () => {
    renderPopover({}, { generationControls: { reasoningEffort: 'medium' } });
    expect((screen.getByLabelText(/Reasoning effort/) as HTMLSelectElement).value).toBe('medium');
  });
});

describe('ComposerChatSettings instructions', () => {
  const project = {
    folderId: 'f1',
    name: 'Ferry',
    userInstructions: 'Use British English.',
    workspaceRoot: null,
    skillIds: ['conduit:pdf'],
    collectionIds: ['c1', 'c2'],
  };

  // Instructions stack (Settings, then the project, then the chat), so the
  // field must not start from the Settings text: saving would send it twice.
  it('holds only the chat’s own instructions and lists what else is used', () => {
    const onOpenProjectSettings = vi.fn();
    render(
      <ComposerChatSettings
        open
        streaming={false}
        defaults={{ userInstructions: 'Default voice.' }}
        override={{}}
        project={project}
        onOpenProjectSettings={onOpenProjectSettings}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expect((screen.getByLabelText(/User instructions/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText('Your instructions from Settings')).toBeTruthy();
    expect(screen.getByText('Instructions from the project “Ferry”')).toBeTruthy();
    expect(screen.getByText('2 document collections from the project “Ferry”')).toBeTruthy();
    expect(screen.getByText('1 skill from the project “Ferry”')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    expect(onOpenProjectSettings).toHaveBeenCalledWith('f1');
  });

  it('lists nothing when there is nothing else', () => {
    renderPopover({ userInstructions: 'Mine.' });
    expect((screen.getByLabelText(/User instructions/) as HTMLTextAreaElement).value).toBe('Mine.');
    expect(screen.queryByText('This chat also uses:')).toBeNull();
  });
});
