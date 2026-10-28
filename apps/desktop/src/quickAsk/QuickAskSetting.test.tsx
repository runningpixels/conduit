import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../ipc/contracts';
import { updateSettings } from '../ipc/client';
import { getQuickAskStatus } from './quickAskIpc';
import { QuickAskSetting } from './QuickAskSetting';
import { shortcutFromPress } from './shortcut';

vi.mock('../ipc/client', () => ({ updateSettings: vi.fn() }));
vi.mock('./quickAskIpc', () => ({
  getQuickAskStatus: vi.fn(async () => ({ supported: true, error: null })),
}));

const base = { theme: 'dark', quickAskShortcut: null } as unknown as AppSettings;

function setup(settings: AppSettings = base) {
  const onSettingsChange = vi.fn();
  const onStatus = vi.fn();
  render(<QuickAskSetting settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />);
  return { onSettingsChange, onStatus, recorder: screen.getByRole('textbox', { name: /Quick ask shortcut/ }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuickAskSetting', () => {
  it('records a combination and saves it', async () => {
    vi.mocked(updateSettings).mockResolvedValue({ ...base, quickAskShortcut: 'Ctrl+Shift+Space' });
    const { recorder, onSettingsChange, onStatus } = setup();
    expect(recorder).toHaveValue('Off');
    fireEvent.focus(recorder);
    expect(recorder).toHaveValue('Press keys…');
    fireEvent.keyDown(recorder, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect(recorder).toHaveValue('Ctrl');
    fireEvent.keyDown(recorder, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ quickAskShortcut: 'Ctrl+Shift+Space' }));
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ quickAskShortcut: 'Ctrl+Shift+Space' })));
    expect(onStatus).toHaveBeenCalledWith('Quick ask opens with Ctrl+Shift+Space.');
  });

  it('asks for a modifier when a bare key is pressed', () => {
    const { recorder } = setup();
    fireEvent.focus(recorder);
    fireEvent.keyDown(recorder, { key: 'q', code: 'KeyQ' });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Hold Ctrl, Alt or Shift/)).toBeInTheDocument();
  });

  it('clears the shortcut', async () => {
    vi.mocked(updateSettings).mockResolvedValue(base);
    const { onStatus } = setup({ ...base, quickAskShortcut: 'Alt+Q' });
    expect(screen.getByRole('textbox', { name: /Quick ask shortcut/ })).toHaveValue('Alt+Q');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ quickAskShortcut: null }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Quick ask shortcut is off.'));
  });

  it('shows an error when the shortcut cannot be registered', async () => {
    vi.mocked(updateSettings).mockRejectedValue(new Error('taken'));
    const { recorder, onSettingsChange } = setup();
    fireEvent.focus(recorder);
    fireEvent.keyDown(recorder, { key: 'q', code: 'KeyQ', altKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t set (Alt|Option)\+Q\. Another app may be using it\./);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('shows the startup error for the saved shortcut', async () => {
    vi.mocked(getQuickAskStatus).mockResolvedValueOnce({ supported: true, error: 'in use' });
    setup({ ...base, quickAskShortcut: 'Alt+Q' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t set Alt\+Q/);
  });

  it('is hidden with a note where global shortcuts do not work', async () => {
    vi.mocked(getQuickAskStatus).mockResolvedValueOnce({ supported: false, error: null });
    render(<QuickAskSetting settings={base} onSettingsChange={vi.fn()} onStatus={vi.fn()} />);
    expect(await screen.findByText(/Wayland session/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('shortcutFromPress', () => {
  const press = (over: Partial<KeyboardEvent>) =>
    ({ code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over }) as KeyboardEvent;

  it('names keys the way the shortcut parser reads them', () => {
    expect(shortcutFromPress(press({ code: 'Space', ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: 'complete',
      shortcut: 'Ctrl+Shift+Space',
    });
    expect(shortcutFromPress(press({ code: 'KeyQ', altKey: true }), false)).toEqual({ kind: 'complete', shortcut: 'Alt+Q' });
    expect(shortcutFromPress(press({ code: 'Digit1', metaKey: true }), false)).toEqual({ kind: 'complete', shortcut: 'Super+1' });
    expect(shortcutFromPress(press({ code: 'KeyK', metaKey: true, altKey: true }), true)).toEqual({
      kind: 'complete',
      shortcut: 'Option+Cmd+K',
    });
    expect(shortcutFromPress(press({ code: 'ArrowUp', ctrlKey: true }), false)).toEqual({ kind: 'complete', shortcut: 'Ctrl+Up' });
  });

  it('waits for a key while only modifiers are held, and refuses bare or unknown keys', () => {
    expect(shortcutFromPress(press({ code: 'ShiftLeft', shiftKey: true }), false)).toEqual({ kind: 'partial', display: 'Shift' });
    expect(shortcutFromPress(press({ code: 'KeyQ' }), false)).toEqual({ kind: 'invalid' });
    expect(shortcutFromPress(press({ code: 'IntlRo', ctrlKey: true }), false)).toEqual({ kind: 'invalid' });
  });
});
