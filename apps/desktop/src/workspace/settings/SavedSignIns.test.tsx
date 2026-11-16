import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const ipc = vi.hoisted(() => ({
  listBrowserSignIns: vi.fn(),
  saveBrowserSignIn: vi.fn(),
  deleteBrowserSignIn: vi.fn(),
}));
vi.mock('../../ipc/client', () => ipc);

import { SavedSignIns } from './SavedSignIns';

const portal = { site: 'portal.example.com', username: 'me@example.com', includeSubdomains: false, unattended: true };

beforeEach(() => {
  vi.resetAllMocks();
  ipc.listBrowserSignIns.mockResolvedValue([]);
  ipc.saveBrowserSignIn.mockImplementation(async ({ password: _password, ...rest }) => rest);
  ipc.deleteBrowserSignIn.mockResolvedValue(undefined);
});

describe('SavedSignIns', () => {
  it('says when there are none', async () => {
    render(<SavedSignIns />);
    expect(await screen.findByText('No saved sign-ins yet.')).toBeInTheDocument();
  });

  it('lists sites and usernames, and which run unattended, never a password', async () => {
    ipc.listBrowserSignIns.mockResolvedValue([portal]);
    render(<SavedSignIns />);
    expect(await screen.findByText('portal.example.com')).toBeInTheDocument();
    expect(screen.getByText('me@example.com · used when nobody is watching')).toBeInTheDocument();
  });

  it('adds a sign-in with its password and switches', async () => {
    render(<SavedSignIns />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a sign-in' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'portal.example.com' } });
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2-secret' } });
    fireEvent.click(screen.getByLabelText('Workflows may use it when nobody is watching'));
    fireEvent.click(save);
    await waitFor(() =>
      expect(ipc.saveBrowserSignIn).toHaveBeenCalledWith({
        site: 'portal.example.com',
        username: 'me@example.com',
        password: 'hunter2-secret',
        includeSubdomains: false,
        unattended: true,
      }),
    );
    expect(await screen.findByText('Sign-in saved.')).toBeInTheDocument();
    expect(screen.getByText('portal.example.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('hunter2-secret')).toBeNull();
  });

  it('edits without retyping the password, and deletes', async () => {
    ipc.listBrowserSignIns.mockResolvedValue([portal]);
    render(<SavedSignIns />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the sign-in for portal.example.com' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', 'Leave empty to keep the saved password');
    fireEvent.click(screen.getByLabelText('Workflows may use it when nobody is watching'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(ipc.saveBrowserSignIn).toHaveBeenCalledWith(expect.objectContaining({ password: '', unattended: false })),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the sign-in for portal.example.com' }));
    await waitFor(() => expect(ipc.deleteBrowserSignIn).toHaveBeenCalledWith('portal.example.com'));
    expect(await screen.findByText('No saved sign-ins yet.')).toBeInTheDocument();
  });

  it('shows why a save was refused', async () => {
    ipc.saveBrowserSignIn.mockRejectedValue({ code: 'error.browser.signInBadSite', fallback: 'bad', params: { site: 'x' } });
    render(<SavedSignIns />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a sign-in' }));
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'me' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('“x” isn’t a site. Write a host such as example.com.')).toBeInTheDocument();
  });
});
