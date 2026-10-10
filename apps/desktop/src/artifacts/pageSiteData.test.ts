import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  mintPageClear: vi.fn(),
  listPageOrigins: vi.fn(),
  forgetPageOrigin: vi.fn(async () => {}),
  clearPageCookies: vi.fn(async () => 0),
}));
const ipc = vi.hoisted(() => ({ invokeCommand: vi.fn(async () => undefined) }));
vi.mock('../ipc/client', () => client);
vi.mock('../ipc/errors', () => ipc);

import {
  PAGE_DATA_CLEARED_MESSAGE_TYPE,
  clearAllPageSiteData,
  clearPageSiteData,
  sweepPageSiteData,
} from './pageSiteData';

const ORIGIN = 'http://0123456789abcdef0123456789abcdef.page.localhost:4321';

/** The hidden clear frame, once appended. */
const clearFrame = () => document.querySelector('iframe[src$="/__clear"]') as HTMLIFrameElement | null;

/** Post from the clear frame's window, as its page would. */
function reportFrom(frame: HTMLIFrameElement, origin = ORIGIN, type = PAGE_DATA_CLEARED_MESSAGE_TYPE) {
  window.dispatchEvent(new MessageEvent('message', { data: { type }, source: frame.contentWindow, origin }));
}

beforeEach(() => {
  vi.clearAllMocks();
  client.mintPageClear.mockImplementation(async () => ({
    token: 'tok',
    url: `${ORIGIN}/tok/__clear`,
    origin: ORIGIN,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('clearPageSiteData', () => {
  it('loads the clear URL in a hidden same-origin frame and resolves on its message', async () => {
    const done = clearPageSiteData('app:one');
    await vi.waitFor(() => expect(clearFrame()).not.toBeNull());
    const frame = clearFrame()!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    // Wrong origin or wrong message: ignored.
    reportFrom(frame, 'http://tauri.localhost');
    reportFrom(frame, ORIGIN, 'something-else');
    reportFrom(frame);
    await expect(done).resolves.toBe(true);
    expect(clearFrame()).toBeNull();
    expect(ipc.invokeCommand).toHaveBeenCalledWith('drop_artifact_frame', { token: 'tok' });
    expect(client.forgetPageOrigin).toHaveBeenCalledWith('app:one');
  });

  it('gives up after the timeout and keeps the page listed', async () => {
    vi.useFakeTimers();
    const done = clearPageSiteData('app:one', 5000);
    await vi.waitFor(() => expect(clearFrame()).not.toBeNull());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(false);
    expect(clearFrame()).toBeNull();
    expect(client.forgetPageOrigin).not.toHaveBeenCalled();
  });

  it('has nothing to do when the page server is not running, and fails when minting fails', async () => {
    client.mintPageClear.mockResolvedValueOnce(null);
    await expect(clearPageSiteData('app:one')).resolves.toBe(true);
    client.mintPageClear.mockRejectedValueOnce(new Error('bad'));
    await expect(clearPageSiteData('app:one')).resolves.toBe(false);
    expect(clearFrame()).toBeNull();
  });
});

/** Answer every clear frame as it appears. */
function autoReport() {
  const observer = new MutationObserver(() => {
    const frame = clearFrame();
    if (frame) queueMicrotask(() => reportFrom(frame));
  });
  observer.observe(document.body, { childList: true });
  return observer;
}

describe('clearAllPageSiteData and sweepPageSiteData', () => {
  it('clears every listed page, then the embed cookies', async () => {
    client.listPageOrigins.mockResolvedValue([
      { principal: 'app:one', exists: true, granted: true, fullAccess: true },
      { principal: 'artifact:two', exists: false, granted: false, fullAccess: false },
    ]);
    const observer = autoReport();
    const result = await clearAllPageSiteData();
    observer.disconnect();
    expect(result).toEqual({ cleared: 2, failed: 0 });
    expect(client.mintPageClear.mock.calls.map(([p]) => p)).toEqual(['app:one', 'artifact:two']);
    expect(client.clearPageCookies).toHaveBeenCalledTimes(1);
  });

  it('sweeps only pages deleted or without full access, and honours a switch override', async () => {
    client.listPageOrigins.mockResolvedValue([
      { principal: 'app:kept', exists: true, granted: true, fullAccess: true },
      { principal: 'app:deleted', exists: false, granted: true, fullAccess: true },
      { principal: 'app:revoked', exists: true, granted: false, fullAccess: false },
      { principal: 'app:switch', exists: true, granted: false, fullAccess: true },
    ]);
    const observer = autoReport();
    await sweepPageSiteData();
    expect(client.mintPageClear.mock.calls.map(([p]) => p)).toEqual(['app:deleted', 'app:revoked']);
    client.mintPageClear.mockClear();
    // The every-page switch was just turned off (not yet saved).
    await sweepPageSiteData({ everyPage: false });
    observer.disconnect();
    expect(client.mintPageClear.mock.calls.map(([p]) => p)).toEqual(['app:deleted', 'app:revoked', 'app:switch']);
    expect(client.clearPageCookies).not.toHaveBeenCalled();
  });
});
