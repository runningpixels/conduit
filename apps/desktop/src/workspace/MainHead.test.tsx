import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MainHead } from './MainHead';

function renderHead(props: Partial<Parameters<typeof MainHead>[0]> = {}) {
  return render(
    <MainHead
      effectiveTheme="dark"
      onToggleTheme={vi.fn()}
      panelOpen={false}
      onTogglePanel={vi.fn()}
      {...props}
    />,
  );
}

/**
 * The context-panel toggle is the only way to reach the artifact panel now that
 * the full-height edge rail is gone, so the count it carries is what keeps the
 * panel discoverable. Ported verbatim from Titlebar.test.tsx — V9 moves this
 * control into the title strip but does not change what it does.
 */
describe('context panel toggle', () => {
  it('shows no badge when nothing is hidden', () => {
    renderHead({ hiddenArtifactCount: 0 });
    const toggle = screen.getByRole('button', { name: 'Toggle context panel' });
    expect(toggle.querySelector('.panel-toggle-badge')).toBeNull();
  });

  it('badges the hidden artifact count and says so in the label', () => {
    renderHead({ hiddenArtifactCount: 3 });
    const toggle = screen.getByRole('button', { name: 'Show context panel (3 artifacts)' });
    expect(toggle.querySelector('.panel-toggle-badge')).toHaveTextContent('3');
  });

  it('singularizes a count of one', () => {
    renderHead({ hiddenArtifactCount: 1 });
    expect(
      screen.getByRole('button', { name: 'Show context panel (1 artifact)' }),
    ).toBeInTheDocument();
  });

  // The badge is a 13px circle; past two digits it would outgrow the button.
  it('caps the badge at 9+', () => {
    renderHead({ hiddenArtifactCount: 24 });
    const toggle = screen.getByRole('button', { name: /Show context panel/ });
    expect(toggle.querySelector('.panel-toggle-badge')).toHaveTextContent('9+');
  });

  it('reflects the open state to assistive tech', () => {
    renderHead({ panelOpen: true });
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('title strip', () => {
  it('names the active chat', () => {
    renderHead({ title: 'Triage notes — acme/conduit' });
    expect(screen.getByText('Triage notes — acme/conduit')).toBeInTheDocument();
  });

  // The strip is the only place the chat's name appears, so it cannot render
  // empty before a conversation is selected.
  it('falls back to a placeholder before a chat is selected', () => {
    renderHead({ title: undefined });
    expect(screen.getByText('New chat')).toBeInTheDocument();
  });

  /**
   * The caption row is the window's drag surface; this strip is app content.
   * Asserted in the negative because the strip *was* a drag region, and that
   * arrangement obliged every non-interactive child to repeat the attribute —
   * `.main-title` did not, leaving most of the bar dead to the pointer.
   */
  it('is not a drag region — TitleBar owns that', () => {
    const { container } = renderHead();
    expect(container.querySelector('.main-head')).not.toHaveAttribute('data-tauri-drag-region');
  });

  it('toggles the theme', async () => {
    const onToggleTheme = vi.fn();
    renderHead({ onToggleTheme });
    screen.getByRole('button', { name: 'Toggle light and dark mode' }).click();
    expect(onToggleTheme).toHaveBeenCalledOnce();
  });
});
