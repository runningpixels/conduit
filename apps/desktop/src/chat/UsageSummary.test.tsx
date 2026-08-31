import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageSummary } from './UsageSummary';

describe('UsageSummary', () => {
  it('renders an info control with token usage in the tip, without web search counts', () => {
    render(
      <UsageSummary
        usage={{ inputTokens: 100n, outputTokens: 50n }}
        searchCost={9}
      />,
    );

    expect(screen.getByRole('button', { name: /Token usage: in: 100 · out: 50/ })).toBeInTheDocument();
    expect(screen.getByText(/in: 100/)).toBeInTheDocument();
    expect(screen.getByText(/out: 50/)).toBeInTheDocument();
    expect(screen.queryByText(/web searches/i)).toBeNull();
  });

  it('renders nothing when only searchCost is provided', () => {
    const { container } = render(<UsageSummary searchCost={4} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not crash when optional token fields are null (IPC bridge sends null for Rust None)', () => {
    // Rust Option<u64> serializes to null over the IPC bridge, not undefined.
    const { container } = render(
      <UsageSummary
        usage={{
          inputTokens: null as unknown as bigint,
          outputTokens: null as unknown as bigint,
          cacheTokens: null as unknown as bigint,
          cacheReadTokens: null as unknown as bigint,
          cacheWriteTokens: null as unknown as bigint,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders partial usage when some fields are null', () => {
    render(
      <UsageSummary
        usage={{ inputTokens: 100n, outputTokens: null as unknown as bigint, cacheTokens: null as unknown as bigint }}
      />,
    );
    expect(screen.getByRole('button', { name: /Token usage: in: 100/ })).toBeInTheDocument();
    expect(screen.getByText(/in: 100/)).toBeInTheDocument();
    expect(screen.queryByText(/out:/)).toBeNull();
    expect(screen.queryByText(/cache:/)).toBeNull();
  });
});
