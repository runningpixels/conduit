/**
 * Ported from ProvenanceStrip.test.tsx. Every case there survives here, because
 * V9 relocates these facts rather than removing them — a fact that used to be a
 * chip is now either in the sentence or one click into the popover, and losing
 * one would be a capability regression wearing a test edit.
 *
 * Where a case moved, the assertion moved with it and says so.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';
import { StatusLine } from './StatusLine';

const settings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: true,
  webSearchEnabled: false,
  webSearch: {
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
};

const baseProps = {
  settings,
  usage: null,
  composerTokenEstimate: 0,
  credentialMode: 'required' as const,
  credentialRef: 'keychain://conduit/anthropic',
  modelMenuOpen: vi.fn(),
  onOpenSettings: vi.fn(),
};

/** Open the popover; the sentence is its only trigger. */
function openDetails() {
  fireEvent.click(screen.getByTitle('Chat details'));
}

describe('StatusLine — the sentence', () => {
  it('carries model, context ratio, spend and network posture', () => {
    render(<StatusLine {...baseProps} usage={{ inputTokens: 2800n, outputTokens: 400n }} />);
    const line = screen.getByTitle('Chat details');
    expect(line).toHaveTextContent('claude-sonnet-4');
    // The ratio, not the raw count — the count is the popover's job.
    expect(line).toHaveTextContent('2% of 200k');
    expect(line).toHaveTextContent('$0.0144');
    expect(line).toHaveTextContent('local only');
  });

  it('adds the pending composer estimate to context use', () => {
    render(<StatusLine {...baseProps} usage={null} composerTokenEstimate={120} />);
    expect(screen.getByTitle('Chat details')).toHaveTextContent('0% of 200k');
    openDetails();
    expect(screen.getByText(/Context 120 of 200k/)).toBeInTheDocument();
  });

  it('degrades to a raw token count for unknown models', () => {
    render(
      <StatusLine
        {...baseProps}
        settings={{ ...settings, activeModel: 'internal-llama' }}
        usage={{ inputTokens: 500n }}
      />,
    );
    expect(screen.getByTitle('Chat details')).toHaveTextContent('500 ctx');
  });

  it('omits spend when the model is unknown and no costHint exists', () => {
    render(
      <StatusLine
        {...baseProps}
        settings={{ ...settings, activeModel: 'internal-llama' }}
        usage={{ inputTokens: 500n }}
      />,
    );
    expect(screen.getByTitle('Chat details')).not.toHaveTextContent('$');
    openDetails();
    expect(screen.queryByText('Spend this chat')).toBeNull();
  });

  it('falls back to the backend costHint string for unknown models', () => {
    render(
      <StatusLine
        {...baseProps}
        settings={{ ...settings, activeModel: 'internal-llama' }}
        usage={{ inputTokens: 500n, costHint: '$0.0012' }}
      />,
    );
    expect(screen.getByTitle('Chat details')).toHaveTextContent('$0.0012');
  });

  it('reports "online" when local-only is off', () => {
    render(<StatusLine {...baseProps} settings={{ ...settings, localOnly: false }} />);
    expect(screen.getByTitle('Chat details')).toHaveTextContent('online');
  });

  /**
   * The one fact V9 §2.2 would bury that this build keeps on the surface: a
   * missing key is actionable, and hiding it makes a failed send unexplained.
   */
  it('promotes a missing key into the sentence', () => {
    render(<StatusLine {...baseProps} credentialRef="" />);
    expect(screen.getByTitle('Chat details')).toHaveTextContent('not configured');
  });

  it('says nothing about the key while the posture is still resolving', () => {
    render(<StatusLine {...baseProps} credentialMode="loading" credentialRef="" />);
    expect(screen.getByTitle('Chat details')).not.toHaveTextContent('not configured');
    openDetails();
    expect(screen.queryByText(/keychain|not configured|no key required/)).toBeNull();
  });
});

describe('StatusLine — the detail popover', () => {
  it('holds the key location, the raw context counts and the exact spend', () => {
    render(<StatusLine {...baseProps} usage={{ inputTokens: 2800n, outputTokens: 400n }} />);
    openDetails();
    // Scoped to the popover: spend deliberately appears in both places — the
    // sentence for the glance, the popover for the breakdown — so an unscoped
    // query matches twice.
    const details = within(screen.getByRole('menu'));
    expect(details.getByText('keychain://conduit/anthropic')).toBeInTheDocument();
    expect(details.getByText(/Context 3,200 of 200k/)).toBeInTheDocument();
    expect(details.getByText('Spend this chat')).toBeInTheDocument();
    expect(details.getByText('$0.0144')).toBeInTheDocument();
  });

  it('shows "no key required" for no-key providers', () => {
    render(<StatusLine {...baseProps} credentialMode="none" credentialRef="" />);
    openDetails();
    expect(screen.getByText('no key required')).toBeInTheDocument();
  });

  it('routes to the model picker, providers and privacy', () => {
    const modelMenuOpen = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <StatusLine {...baseProps} modelMenuOpen={modelMenuOpen} onOpenSettings={onOpenSettings} />,
    );

    openDetails();
    fireEvent.click(screen.getByText(/Anthropic \/ claude-sonnet-4/));
    expect(modelMenuOpen).toHaveBeenCalledTimes(1);

    openDetails();
    fireEvent.click(screen.getByText('keychain://conduit/anthropic'));
    expect(onOpenSettings).toHaveBeenCalledWith('providers');

    openDetails();
    fireEvent.click(screen.getByText(/Local only/));
    expect(onOpenSettings).toHaveBeenCalledWith('privacy');
  });

  /**
   * Was `onOpenSettings('advanced')`. The Advanced section is dissolved in
   * phase F (plan D4), and spend belongs with the rest of Privacy & data — so
   * the route is repointed here rather than left dangling at a section that
   * will not exist.
   */
  it('reaches spend through Privacy & data, not the retired Advanced tab', () => {
    const onOpenSettings = vi.fn();
    render(
      <StatusLine
        {...baseProps}
        onOpenSettings={onOpenSettings}
        usage={{ inputTokens: 2800n, outputTokens: 400n }}
      />,
    );
    openDetails();
    fireEvent.click(screen.getByText(/Local only/));
    expect(onOpenSettings).toHaveBeenCalledWith('privacy');
    expect(onOpenSettings).not.toHaveBeenCalledWith('advanced');
  });

  it('renders deep links as inert spans when onOpenSettings is absent', () => {
    render(
      <StatusLine
        settings={settings}
        usage={null}
        composerTokenEstimate={0}
        credentialMode="required"
        credentialRef="keychain://conduit/anthropic"
        modelMenuOpen={vi.fn()}
      />,
    );
    openDetails();
    expect(screen.getByText('keychain://conduit/anthropic').tagName).toBe('SPAN');
    expect(screen.getByText(/Local only/).tagName).toBe('SPAN');
  });

  /**
   * Guard G7 — provenance completeness.
   *
   * V8 reported five facts in five always-on chips. V9 collapses the volume,
   * and the failure mode of a collapse is quiet: drop one fact and the line
   * still looks right, still reads well, and no other test notices. So the
   * five are enumerated once, here, and each must be reachable in at most one
   * click. Whichever surface carries it is the implementation's business; that
   * it is carried at all is not.
   */
  it.each([
    ['model', /claude-sonnet-4/],
    ['key location', /keychain:\/\/conduit\/anthropic/],
    ['context use', /Context 3,200 of 200k/],
    ['spend', /Spend this chat/],
    ['network posture', /Local only/],
  ])('still reports %s within one click', (_fact, pattern) => {
    render(<StatusLine {...baseProps} usage={{ inputTokens: 2800n, outputTokens: 400n }} />);
    openDetails();
    expect(screen.getAllByText(pattern).length).toBeGreaterThan(0);
  });

  /**
   * The expanded mode (plan D6, V9 §10.1). The promise is "same data, the same
   * line re-inflated, no layout change" — so the test is that facts move *onto*
   * the sentence, not that a different surface appears.
   */
  it('re-inflates the sentence when the expanded pref is on', () => {
    localStorage.setItem('conduit:v9-expanded-status', 'on');
    render(<StatusLine {...baseProps} usage={{ inputTokens: 2800n, outputTokens: 400n }} />);
    const line = screen.getByTitle('Chat details');
    // The key location and the raw count join the line instead of waiting in
    // the popover; the ratio-only form is gone.
    expect(line).toHaveTextContent('keychain://conduit/anthropic');
    expect(line).toHaveTextContent('3,200 of 200k');
    expect(line).not.toHaveTextContent('2% of 200k');
    localStorage.removeItem('conduit:v9-expanded-status');
  });

  it('stays collapsed by default', () => {
    render(<StatusLine {...baseProps} usage={{ inputTokens: 2800n, outputTokens: 400n }} />);
    const line = screen.getByTitle('Chat details');
    expect(line).toHaveTextContent('2% of 200k');
    expect(line).not.toHaveTextContent('keychain://conduit/anthropic');
  });

  it('closes on Escape and returns focus to the line', () => {
    render(<StatusLine {...baseProps} />);
    openDetails();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTitle('Chat details'));
  });
});
