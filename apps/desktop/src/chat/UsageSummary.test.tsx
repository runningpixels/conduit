import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageSummary } from './UsageSummary';

describe('UsageSummary', () => {
  it('renders token usage without duplicate web search counts', () => {
    render(
      <UsageSummary
        usage={{ inputTokens: 100n, outputTokens: 50n }}
        searchCost={9}
      />,
    );

    expect(screen.getByText(/in: 100/)).toBeInTheDocument();
    expect(screen.getByText(/out: 50/)).toBeInTheDocument();
    expect(screen.queryByText(/web searches/i)).toBeNull();
  });

  it('renders nothing when only searchCost is provided', () => {
    const { container } = render(<UsageSummary searchCost={4} />);
    expect(container).toBeEmptyDOMElement();
  });
});
