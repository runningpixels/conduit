import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MainHead } from './MainHead';

function renderHead(props: Partial<Parameters<typeof MainHead>[0]> = {}) {
  return render(
    <MainHead
      effectiveTheme="dark"
      onToggleTheme={vi.fn()}
      panelOpen={false}
      onTogglePanel={vi.fn()}
      onToggleSidebar={vi.fn()}
      onNewChat={vi.fn()}
      onOpenPalette={vi.fn()}
      onOpenSettings={vi.fn()}
      onExportDiagnostics={vi.fn()}
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

/**
 * The strip's settings entry point. Before it, the only pointer path to
 * settings was the sidebar's workspace chip — two clicks deep, and gone
 * entirely once the sidebar was collapsed.
 */
describe('settings split-button', () => {
  it('opens settings in one click, without naming a section', () => {
    const onOpenSettings = vi.fn();
    renderHead({ onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    // No section: the app reopens wherever the sheet was last left.
    expect(onOpenSettings).toHaveBeenCalledWith();
  });

  it('lists sections from the chevron, with focus on the first item', () => {
    renderHead();
    const trigger = screen.getByRole('button', { name: 'Settings menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Settings menu' });
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(items).toEqual([
      'SettingsCtrl+,',
      'Providers & keys',
      'Chat defaults',
      'Connectors',
      'Appearance',
      'Privacy & data',
      'Export diagnostics',
      'About',
    ]);
    expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
  });

  it.each([
    ['Providers & keys', 'providers'],
    ['Chat defaults', 'chat'],
    ['Connectors', 'connectors'],
    ['Appearance', 'appearance'],
    ['Privacy & data', 'privacy'],
    ['About', 'about'],
  ])('routes %s to its section and closes', (label, section) => {
    const onOpenSettings = vi.fn();
    renderHead({ onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(onOpenSettings).toHaveBeenCalledWith(section);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs diagnostics export rather than opening a section', () => {
    const onOpenSettings = vi.fn();
    const onExportDiagnostics = vi.fn();
    renderHead({ onOpenSettings, onExportDiagnostics });
    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export diagnostics' }));
    expect(onExportDiagnostics).toHaveBeenCalledOnce();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('shows provider and connector counts', () => {
    renderHead({ providerCount: 3, connectorCount: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));
    expect(screen.getByRole('menuitem', { name: /Providers & keys/ }).querySelector('.tail')).toHaveTextContent('3');
    expect(screen.getByRole('menuitem', { name: /Connectors/ }).querySelector('.tail')).toHaveTextContent('2');
  });

  it('opens the menu on right-click of the gear', () => {
    renderHead();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('menu', { name: 'Settings menu' })).toBeInTheDocument();
  });

  it('closes on Escape and on a press outside', () => {
    renderHead();
    const trigger = screen.getByRole('button', { name: 'Settings menu' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

/**
 * The sidebar's row of actions, standing in while it is collapsed. Visibility
 * is CSS (`html[data-sidebar="closed"] .head-nav`, pinned by
 * shellContract.test.ts), so this checks only that each one does its job.
 */
describe('collapsed-sidebar actions', () => {
  it.each([
    ['Open sidebar', 'onToggleSidebar'],
    ['New chat', 'onNewChat'],
    ['Search', 'onOpenPalette'],
  ] as const)('%s calls %s', (label, handler) => {
    const fn = vi.fn();
    renderHead({ [handler]: fn });
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('reports whether the sidebar overlay is showing', () => {
    const { rerender } = renderHead({ sidebarOverlayOpen: false });
    const toggle = screen.getByRole('button', { name: 'Open sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'sidebar');
    rerender(
      <MainHead
        effectiveTheme="dark"
        onToggleTheme={vi.fn()}
        panelOpen={false}
        onTogglePanel={vi.fn()}
        onToggleSidebar={vi.fn()}
        onNewChat={vi.fn()}
        onOpenPalette={vi.fn()}
        onOpenSettings={vi.fn()}
        onExportDiagnostics={vi.fn()}
        sidebarOverlayOpen
      />,
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
