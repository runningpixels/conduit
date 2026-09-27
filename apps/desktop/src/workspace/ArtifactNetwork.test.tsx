import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactNetworkBanner, ArtifactNetworkChip, ArtifactNetworkDialog } from './ArtifactNetwork';

const site = (origin: string, body: ArrayBuffer | null = null, contentType?: string) => ({
  origin,
  first: { method: body ? 'POST' : 'GET', url: `${origin}/v1/data?q=1`, body, contentType },
});

describe('ArtifactNetworkBanner', () => {
  it('shows nothing until a site is waiting', () => {
    const { container } = render(<ArtifactNetworkBanner pending={[]} onReview={() => {}} onNotNow={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('names the site and offers Review / Not now', () => {
    const onReview = vi.fn();
    const onNotNow = vi.fn();
    render(<ArtifactNetworkBanner pending={[site('https://api.open-meteo.com')]} onReview={onReview} onNotNow={onNotNow} />);
    expect(screen.getByRole('status').textContent).toContain('api.open-meteo.com');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onReview).toHaveBeenCalled();
    expect(onNotNow).toHaveBeenCalled();
  });
});

describe('ArtifactNetworkDialog', () => {
  it('shows the declared reason, the request and a preview of the data sent', () => {
    const onDecide = vi.fn();
    render(
      <ArtifactNetworkDialog
        open
        title="Paris Weather"
        sites={[
          site('https://api.open-meteo.com'),
          site('https://collector.example', new TextEncoder().encode('{"notes":"secret"}').buffer, 'application/json'),
        ]}
        declared={[{ origin: 'https://api.open-meteo.com', reason: 'live weather' }]}
        onDecide={onDecide}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Paris Weather');
    expect(dialog.textContent).toContain('The page says: live weather');
    expect(dialog.textContent).toContain('The page did not list this site.');
    expect(dialog.textContent).toContain('GET /v1/data?q=1');
    expect(dialog.textContent).toContain('{"notes":"secret"}');
    expect(dialog.textContent).toContain('This page will send data to the site.');
    fireEvent.click(screen.getByRole('button', { name: 'Always allow for this page' }));
    expect(onDecide).toHaveBeenCalledWith('page', false);
  });

  it('treats Escape as "Don\'t allow" without letting the panel see it', () => {
    const onDecide = vi.fn();
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    render(<ArtifactNetworkDialog open title={null} sites={[site('https://a.example')]} declared={[]} onDecide={onDecide} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    document.removeEventListener('keydown', panelEscape);
    expect(onDecide).toHaveBeenCalledWith('deny', false);
    expect(panelEscape).not.toHaveBeenCalled();
  });
});

describe('ArtifactNetworkDialog on a redirect', () => {
  it('says where a redirect came from and can allow any public site', () => {
    const onDecide = vi.fn();
    render(
      <ArtifactNetworkDialog
        open
        title={null}
        sites={[{ ...site('https://api.frankfurter.dev'), redirectFrom: 'https://api.frankfurter.app' }]}
        declared={[]}
        onDecide={onDecide}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('The page asked for api.frankfurter.app, which sent it on to api.frankfurter.dev.');
    fireEvent.click(screen.getByRole('checkbox', { name: /any public site/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow this time' }));
    expect(onDecide).toHaveBeenCalledWith('session', true);
  });
});

describe('ArtifactNetworkChip', () => {
  it('hides for a page with no sites', () => {
    const { container } = render(
      <ArtifactNetworkChip declared={[]} scripted={[]} state={null} denied={new Set()} log={[]} onRevoke={() => {}} />,
    );
    expect(container.textContent).toBe('');
  });

  it('lists sites with their status, and Escape closes only the list', () => {
    const onRevoke = vi.fn();
    const panelEscape = vi.fn();
    render(
      <ArtifactNetworkChip
        declared={[{ origin: 'https://api.open-meteo.com', reason: 'weather' }]}
        scripted={['https://api.github.com']}
        state={{ blockedReason: null, always: ['https://api.open-meteo.com'], session: [] }}
        denied={new Set(['https://api.github.com'])}
        log={[
          { id: 1, at: 0, origin: 'https://api.open-meteo.com', method: 'GET', url: 'https://api.open-meteo.com/v1', status: 200, bytes: 10, ms: 5, sinceChange: false },
        ]}
        onRevoke={onRevoke}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sites this page connects to' }));
    const popover = screen.getByRole('dialog');
    expect(popover.textContent).toContain('Always allowed');
    expect(popover.textContent).toContain('Not allowed');
    expect(popover.textContent).toContain('Found in the page');
    fireEvent.click(screen.getByRole('button', { name: 'Remove permission' }));
    expect(onRevoke).toHaveBeenCalledWith('https://api.open-meteo.com');

    document.addEventListener('keydown', panelEscape);
    fireEvent.keyDown(popover, { key: 'Escape' });
    document.removeEventListener('keydown', panelEscape);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(panelEscape).not.toHaveBeenCalled();
  });
});
