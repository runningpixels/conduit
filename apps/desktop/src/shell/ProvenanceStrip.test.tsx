import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';
import { ProvenanceStrip } from './ProvenanceStrip';

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

describe('ProvenanceStrip', () => {
  it('renders provider/model, keychain ref, context, and local-only segments', () => {
    render(
      <ProvenanceStrip
        {...baseProps}
        usage={{ inputTokens: 2800n, outputTokens: 400n }}
      />,
    );
    expect(
      screen.getByText('Anthropic / claude-sonnet-4'),
    ).toBeInTheDocument();
    expect(screen.getByText('keychain://conduit/anthropic')).toBeInTheDocument();
    expect(screen.getByText('3,200 ctx · 2% of 200k')).toBeInTheDocument();
    expect(screen.getByText('$0.0144 this chat')).toBeInTheDocument();
    expect(screen.getByText('● local only')).toBeInTheDocument();
  });

  it('adds the pending composer estimate to context use', () => {
    render(
      <ProvenanceStrip
        {...baseProps}
        usage={null}
        composerTokenEstimate={120}
      />,
    );
    expect(screen.getByText('120 ctx · 0% of 200k')).toBeInTheDocument();
  });

  it('degrades to a raw token count for unknown models', () => {
    render(
      <ProvenanceStrip
        {...baseProps}
        settings={{ ...settings, activeModel: 'internal-llama' }}
        usage={{ inputTokens: 500n }}
      />,
    );
    expect(screen.getByText('500 ctx')).toBeInTheDocument();
  });

  it('omits the spend segment when the model is unknown and no costHint exists', () => {
    render(
      <ProvenanceStrip
        {...baseProps}
        settings={{ ...settings, activeModel: 'internal-llama' }}
        usage={{ inputTokens: 500n }}
      />,
    );
    expect(screen.queryByText(/\$.*this chat/)).toBeNull();
  });

  it('falls back to the backend costHint string for unknown models', () => {
    render(
      <ProvenanceStrip
        {...baseProps}
        settings={{ ...settings, activeModel: 'internal-llama' }}
        usage={{ inputTokens: 500n, costHint: '$0.0012' }}
      />,
    );
    expect(screen.getByText('$0.0012 this chat')).toBeInTheDocument();
  });

  it('shows "no key required" for no-key providers', () => {
    render(<ProvenanceStrip {...baseProps} credentialMode="none" credentialRef="" />);
    expect(screen.getByText('no key required')).toBeInTheDocument();
  });

  it('shows a warning "not configured" without a keychain ref', () => {
    render(
      <ProvenanceStrip {...baseProps} credentialRef="" />,
    );
    expect(screen.getByText('not configured')).toBeInTheDocument();
  });

  it('renders non-interactive spans when onOpenSettings is absent', () => {
    render(
      <ProvenanceStrip
        settings={settings}
        usage={null}
        composerTokenEstimate={0}
        credentialMode="required"
        credentialRef="keychain://conduit/anthropic"
        modelMenuOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('keychain://conduit/anthropic').tagName).toBe('SPAN');
    expect(screen.getByText('● local only').tagName).toBe('SPAN');
  });

  it('opens the model menu and settings sections on click', () => {
    const modelMenuOpen = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ProvenanceStrip
        {...baseProps}
        modelMenuOpen={modelMenuOpen}
        onOpenSettings={onOpenSettings}
      />,
    );
    screen.getByText('Anthropic / claude-sonnet-4').click();
    expect(modelMenuOpen).toHaveBeenCalledTimes(1);
    screen.getByText('keychain://conduit/anthropic').click();
    expect(onOpenSettings).toHaveBeenCalledWith('providers');
    screen.getByText('● local only').click();
    expect(onOpenSettings).toHaveBeenCalledWith('privacy');
  });

  it('spend segment is a button that opens Advanced (Usage & Cost) when onOpenSettings is present', () => {
    const onOpenSettings = vi.fn();
    render(
      <ProvenanceStrip
        {...baseProps}
        onOpenSettings={onOpenSettings}
        usage={{ inputTokens: 2800n, outputTokens: 400n }}
      />,
    );
    const spend = screen.getByText('$0.0144 this chat');
    expect(spend.tagName).toBe('BUTTON');
    spend.click();
    expect(onOpenSettings).toHaveBeenCalledWith('advanced');
  });

  it('spend segment stays an inert span when onOpenSettings is absent', () => {
    render(
      <ProvenanceStrip
        settings={settings}
        usage={{ inputTokens: 2800n, outputTokens: 400n }}
        composerTokenEstimate={0}
        credentialMode="required"
        credentialRef="keychain://conduit/anthropic"
        modelMenuOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('$0.0144 this chat').tagName).toBe('SPAN');
  });
});
