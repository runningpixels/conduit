import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const ipc = vi.hoisted(() => ({
  dictationStatus: vi.fn(),
  dictationStart: vi.fn(),
  dictationStop: vi.fn(),
  dictationCancel: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const events = vi.hoisted(() => ({ handlers: new Map<string, (e: { payload: unknown }) => void>() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return () => events.handlers.delete(name);
  }),
}));

import { DictationButton } from './DictationButton';

const ready = { provider: 'openrouter', providerName: 'OpenRouter', blocked: null, maxSeconds: 300 };

describe('DictationButton', () => {
  beforeEach(() => {
    ipc.dictationStatus.mockResolvedValue(ready);
    ipc.dictationStart.mockResolvedValue(undefined);
    ipc.dictationStop.mockResolvedValue('Hello from the microphone.');
    ipc.dictationCancel.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    events.handlers.clear();
  });

  it('says where the voice goes, records, and hands back the text', async () => {
    const onText = vi.fn();
    render(<DictationButton onText={onText} />);
    const mic = await screen.findByRole('button', { name: /sent to OpenRouter/ });

    await act(async () => {
      fireEvent.click(mic);
    });
    expect(ipc.dictationStart).toHaveBeenCalled();
    const stop = await screen.findByRole('button', { name: 'Stop and add the text' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    expect(stop).toHaveTextContent('0:00');

    await act(async () => {
      fireEvent.click(stop);
    });
    expect(ipc.dictationStop).toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith('Hello from the microphone.');
    expect(await screen.findByRole('button', { name: /sent to OpenRouter/ })).toBeEnabled();
  });

  it('is disabled, with the reason, when no key can transcribe or local-only is on', async () => {
    ipc.dictationStatus.mockResolvedValue({ ...ready, provider: null, providerName: null, blocked: 'noProvider' });
    const { unmount } = render(<DictationButton onText={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /needs an OpenAI, OpenRouter or Groq API key/ })).toBeDisabled();
    unmount();

    ipc.dictationStatus.mockResolvedValue({ ...ready, provider: null, providerName: null, blocked: 'localOnly' });
    render(<DictationButton onText={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /off in local-only mode/ })).toBeDisabled();
  });

  it('Escape discards the recording without sending it', async () => {
    const onText = vi.fn();
    render(<DictationButton onText={onText} />);
    const mic = await screen.findByRole('button', { name: /sent to OpenRouter/ });
    await act(async () => {
      fireEvent.click(mic);
    });
    await screen.findByRole('button', { name: 'Stop and add the text' });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(ipc.dictationCancel).toHaveBeenCalled();
    expect(ipc.dictationStop).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it('stops and transcribes when the recording reaches its limit', async () => {
    const onText = vi.fn();
    render(<DictationButton onText={onText} />);
    const mic = await screen.findByRole('button', { name: /sent to OpenRouter/ });
    await act(async () => {
      fireEvent.click(mic);
    });
    await waitFor(() => expect(events.handlers.has('dictation-full')).toBe(true));
    await act(async () => {
      events.handlers.get('dictation-full')!({ payload: null });
    });
    expect(ipc.dictationStop).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('Hello from the microphone.');
  });

  it('shows the error in the user’s words when the microphone fails', async () => {
    ipc.dictationStart.mockRejectedValue({
      code: 'error.dictation.noMicrophone',
      params: {},
      fallback: 'No microphone',
    });
    render(<DictationButton onText={vi.fn()} />);
    const mic = await screen.findByRole('button', { name: /sent to OpenRouter/ });
    await act(async () => {
      fireEvent.click(mic);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('No microphone was found.');
  });

  it('discards a recording left running when the composer goes away', async () => {
    const { unmount } = render(<DictationButton onText={vi.fn()} />);
    const mic = await screen.findByRole('button', { name: /sent to OpenRouter/ });
    await act(async () => {
      fireEvent.click(mic);
    });
    await screen.findByRole('button', { name: 'Stop and add the text' });
    unmount();
    expect(ipc.dictationCancel).toHaveBeenCalled();
  });
});
