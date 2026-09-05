import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerSkills } from './ComposerSkills';
import type { SkillSummary } from '../ipc/contracts';

const skills: SkillSummary[] = [
  {
    id: 'claude:pdf-processing',
    name: 'pdf-processing',
    description: 'Extract PDF text',
    source: 'claude',
    path: '/home/.claude/skills/pdf-processing',
    hasScripts: true,
    hasReferences: false,
    hasAssets: false,
  },
];

describe('ComposerSkills', () => {
  it('enables a skill for this chat', () => {
    const onToggle = vi.fn();
    render(
      <ComposerSkills
        open
        streaming={false}
        skills={skills}
        enabledIds={[]}
        onClose={vi.fn()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Enable pdf-processing' }));
    expect(onToggle).toHaveBeenCalledWith('claude:pdf-processing', true);
  });

  it('disables a previously enabled skill', () => {
    const onToggle = vi.fn();
    render(
      <ComposerSkills
        open
        streaming={false}
        skills={skills}
        enabledIds={['claude:pdf-processing']}
        onClose={vi.fn()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Disable pdf-processing' }));
    expect(onToggle).toHaveBeenCalledWith('claude:pdf-processing', false);
  });
});
