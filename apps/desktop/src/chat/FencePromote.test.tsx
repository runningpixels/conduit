import { describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { FencePromote, useSyncPromoteReady } from './FencePromote';

describe('FencePromote', () => {
  it('shows only outgoing until ready', () => {
    const { container } = render(
      <FencePromote
        outgoing={<pre data-testid="src">source</pre>}
        incoming={<div data-testid="rich">rich</div>}
        ready={false}
      />,
    );
    expect(container.querySelector('[data-testid="src"]')).not.toBeNull();
    expect(container.querySelector('.fence-promote-incoming.is-preparing')).not.toBeNull();
    expect(container.querySelector('.fence-promote-incoming.is-shown')).toBeNull();
  });

  it('promotes to incoming when ready under reduce-motion', async () => {
    document.documentElement.setAttribute('data-reduce-motion', 'on');
    const { container, rerender } = render(
      <FencePromote
        outgoing={<pre data-testid="src">source</pre>}
        incoming={<div data-testid="rich">rich</div>}
        ready={false}
      />,
    );
    rerender(
      <FencePromote
        outgoing={<pre data-testid="src">source</pre>}
        incoming={<div data-testid="rich">rich</div>}
        ready
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="rich"]')).not.toBeNull();
      expect(container.querySelector('.fence-promote-incoming.is-shown')).not.toBeNull();
    });
    // Instant promote drops the outgoing layer.
    expect(container.querySelector('[data-testid="src"]')).toBeNull();
    document.documentElement.removeAttribute('data-reduce-motion');
  });
});

describe('useSyncPromoteReady', () => {
  it('flips true after an animation frame', async () => {
    let value = false;
    function Probe() {
      value = useSyncPromoteReady();
      return null;
    }
    render(<Probe />);
    expect(value).toBe(false);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(value).toBe(true);
  });
});
