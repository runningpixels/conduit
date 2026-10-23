import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelperControls } from './HelperControls';

const ipc = vi.hoisted(() => ({
  stopAgentCall: vi.fn(),
  redirectAgentCall: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

beforeEach(() => {
  vi.clearAllMocks();
  ipc.stopAgentCall.mockResolvedValue(undefined);
  ipc.redirectAgentCall.mockResolvedValue(undefined);
});

describe('HelperControls', () => {
  it('stops that helper by call id', async () => {
    render(<HelperControls callId="call-1" name="Researcher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Researcher' }));
    await waitFor(() => expect(ipc.stopAgentCall).toHaveBeenCalledWith('call-1'));
  });

  it('shows why a stop failed for a moment', async () => {
    ipc.stopAgentCall.mockRejectedValue(new Error('gone'));
    render(<HelperControls callId="call-1" name="Researcher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Researcher' }));
    expect(await screen.findByText(/may have just finished/)).toBeInTheDocument();
  });

  it('sends a redirect on Enter', async () => {
    render(<HelperControls callId="call-1" name="Researcher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Redirect Researcher' }));
    const field = screen.getByRole('textbox', { name: 'New instruction for Researcher' });
    fireEvent.change(field, { target: { value: 'Use only primary sources' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(ipc.redirectAgentCall).toHaveBeenCalledWith('call-1', 'Use only primary sources'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('closes the redirect field on Escape and keeps the key from parent handlers', () => {
    const parent = vi.fn();
    render(
      <div onKeyDown={parent}>
        <HelperControls callId="call-1" name="Researcher" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Redirect Researcher' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(parent).not.toHaveBeenCalled();
    expect(ipc.redirectAgentCall).not.toHaveBeenCalled();
  });
});
