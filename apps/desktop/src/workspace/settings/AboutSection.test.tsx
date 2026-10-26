import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AboutSection } from './AboutSection';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn().mockResolvedValue('1.0.0-rc.15') }));
vi.mock('../../ipc/client', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));

const { openExternalUrl } = await import('../../ipc/client');

const PATHS = { root: 'C:\\Conduit', settingsFile: 'C:\\Conduit\\settings.json', database: 'C:\\Conduit\\conduit.db' };

describe('AboutSection', () => {
  it('says which version this is and who makes it', async () => {
    render(<AboutSection paths={PATHS as never} onStatus={vi.fn()} />);
    expect(await screen.findByText('1.0.0-rc.15')).toBeInTheDocument();
    expect(screen.getByText('Made by')).toBeInTheDocument();
    expect(screen.getByText('Emilio Olivares')).toBeInTheDocument();
  });

  it('opens the project links in the browser', () => {
    render(<AboutSection paths={PATHS as never} onStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'github.com/runningpixels/conduit' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/runningpixels/conduit');
    fireEvent.click(screen.getByRole('button', { name: 'Open an issue on GitHub' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/runningpixels/conduit/issues');
  });

  it('still lists where the files are', () => {
    render(<AboutSection paths={PATHS as never} onStatus={vi.fn()} />);
    expect(screen.getByText('Files on this machine')).toBeInTheDocument();
    expect(screen.getByText('C:\\Conduit\\conduit.db')).toBeInTheDocument();
  });
});
