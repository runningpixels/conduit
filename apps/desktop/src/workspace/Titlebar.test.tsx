import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Titlebar } from './Titlebar';

function renderTitlebar(props: Partial<Parameters<typeof Titlebar>[0]> = {}) {
  return render(
    <Titlebar
      effectiveTheme="dark"
      onToggleTheme={vi.fn()}
      onOpenPalette={vi.fn()}
      panelOpen={false}
      onTogglePanel={vi.fn()}
      {...props}
    />,
  );
}

/**
 * The context-panel toggle is the only way to reach the artifact panel now that
 * the full-height edge rail is gone, so the count it carries is what keeps the
 * panel discoverable.
 */
describe('context panel toggle', () => {
  it('shows no badge when nothing is hidden', () => {
    renderTitlebar({ hiddenArtifactCount: 0 });
    const toggle = screen.getByRole('button', { name: 'Toggle context panel' });
    expect(toggle.querySelector('.panel-toggle-badge')).toBeNull();
  });

  it('badges the hidden artifact count and says so in the label', () => {
    renderTitlebar({ hiddenArtifactCount: 3 });
    const toggle = screen.getByRole('button', { name: 'Show context panel (3 artifacts)' });
    expect(toggle.querySelector('.panel-toggle-badge')).toHaveTextContent('3');
  });

  it('singularizes a count of one', () => {
    renderTitlebar({ hiddenArtifactCount: 1 });
    expect(
      screen.getByRole('button', { name: 'Show context panel (1 artifact)' }),
    ).toBeInTheDocument();
  });

  // The badge is a 13px circle; past two digits it would outgrow the button.
  it('caps the badge at 9+', () => {
    renderTitlebar({ hiddenArtifactCount: 24 });
    const toggle = screen.getByRole('button', { name: /Show context panel/ });
    expect(toggle.querySelector('.panel-toggle-badge')).toHaveTextContent('9+');
  });

  it('reflects the open state to assistive tech', () => {
    renderTitlebar({ panelOpen: true });
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
