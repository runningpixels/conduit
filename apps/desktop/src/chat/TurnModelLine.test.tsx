import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { shouldShowModelLine, TurnModelLine } from './TurnModelLine';

describe('shouldShowModelLine (§6.4)', () => {
  // The line reports a *change*. On the first turn nothing has changed yet, and
  // the status line under the composer already names the active model, so
  // opening every conversation with this caption reported nothing new.
  it('hides on the first assistant turn', () => {
    expect(shouldShowModelLine(undefined, { provider: 'anthropic', model: 'claude-sonnet-4' })).toBe(false);
  });

  it('hides when provider and model are unchanged', () => {
    const prev = { provider: 'anthropic', model: 'claude-sonnet-4' };
    expect(shouldShowModelLine(prev, { provider: 'anthropic', model: 'claude-sonnet-4' })).toBe(false);
  });

  it('shows when the provider switches', () => {
    const prev = { provider: 'anthropic', model: 'claude-sonnet-4' };
    expect(shouldShowModelLine(prev, { provider: 'openai', model: 'gpt-4.1-mini' })).toBe(true);
  });

  it('shows when the model changes within the same provider', () => {
    const prev = { provider: 'anthropic', model: 'claude-sonnet-4' };
    expect(shouldShowModelLine(prev, { provider: 'anthropic', model: 'claude-opus-4' })).toBe(true);
  });
});

describe('TurnModelLine', () => {
  it('renders provider / model with a hue dot', () => {
    render(<TurnModelLine provider="anthropic" model="claude-sonnet-4" />);
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('/ claude-sonnet-4')).toBeInTheDocument();
    expect(document.querySelector('.turn-model .pdot')).not.toBeNull();
  });

  it('renders the timestamp when provided', () => {
    render(<TurnModelLine provider="anthropic" model="claude-sonnet-4" time="10:42" />);
    expect(screen.getByText('· 10:42')).toBeInTheDocument();
  });

  it('renders the switched-from note in the hue span', () => {
    render(
      <TurnModelLine provider="openai" model="gpt-4.1-mini" switchedFrom="anthropic" />,
    );
    expect(screen.getByText(/switched from Anthropic/i)).toBeInTheDocument();
    expect(document.querySelector('.turn-model .switched')).not.toBeNull();
  });
});
