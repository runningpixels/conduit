import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LinkMenu } from './LinkMenu';
import { openExternalUrl, openInAgentBrowser } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  openExternalUrl: vi.fn(() => Promise.resolve()),
  openInAgentBrowser: vi.fn(() => Promise.resolve()),
}));

function page() {
  return render(
    <div>
      <div className="turn assistant">
        <a href="https://example.com/a">in a reply</a>
      </div>
      <section className="sources-view">
        <a className="source-link" href="https://example.com/source">a source</a>
      </section>
      <div className="elsewhere">
        <a href="https://example.com/b">elsewhere</a>
      </div>
      <div className="turn assistant">
        <a href="#local">not a web link</a>
      </div>
    </div>,
  );
}

describe('LinkMenu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens a link from a reply in the agent’s browser', async () => {
    page();
    render(<LinkMenu />);
    fireEvent.contextMenu(screen.getByText('in a reply'), { clientX: 40, clientY: 50 });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in the agent’s browser' }));
    expect(openInAgentBrowser).toHaveBeenCalledWith('https://example.com/a');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a source in the person’s own browser too', () => {
    page();
    render(<LinkMenu />);
    fireEvent.contextMenu(screen.getByText('a source'), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in your browser' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/source');
  });

  it('leaves other links and in-page links to the webview', () => {
    page();
    render(<LinkMenu />);
    const outside = fireEvent.contextMenu(screen.getByText('elsewhere'));
    const local = fireEvent.contextMenu(screen.getByText('not a web link'));
    expect(screen.queryByRole('menu')).toBeNull();
    // Not cancelled: the webview's own menu still opens.
    expect(outside).toBe(true);
    expect(local).toBe(true);
  });

  it('says why when the agent’s browser can’t open it', async () => {
    vi.mocked(openInAgentBrowser).mockRejectedValueOnce({
      code: 'error.browser.off',
      params: {},
      fallback: 'off',
    });
    const onStatus = vi.fn();
    page();
    render(<LinkMenu onStatus={onStatus} />);
    fireEvent.contextMenu(screen.getByText('in a reply'), { clientX: 40, clientY: 50 });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in the agent’s browser' }));
    });
    expect(onStatus).toHaveBeenCalledWith('The agent’s browser is off. Turn it on in Settings, under Computer.');
  });
});
