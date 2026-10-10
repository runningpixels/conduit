import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inside Tauri: a full-access page with a principal is served from its own
// origin on the page server (Rust `page_server`).
const PAGE = 'http://0123456789abcdef0123456789abcdef.page.localhost:4321';
const core = vi.hoisted(() => ({
  isTauri: () => true,
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}));
const ipc = vi.hoisted(() => ({ invokeCommand: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);
vi.mock('../ipc/errors', () => ipc);

import { HtmlArtifactRenderer, artifactSandbox } from './HtmlArtifactRenderer';
import { ARTIFACT_FETCH_MESSAGE_TYPE, ARTIFACT_FETCH_RESULT_MESSAGE_TYPE } from './networkBridge';

beforeEach(() => {
  vi.clearAllMocks();
  ipc.invokeCommand.mockImplementation(async (command: string, args?: { principal?: string }) => {
    if (command !== 'put_artifact_frame') return undefined;
    return args?.principal ? { token: 'tok', url: `${PAGE}/tok` } : { token: 'tok', url: null };
  });
});

const frame = (container: HTMLElement) => container.querySelector('iframe')!;

describe('HtmlArtifactRenderer on a page origin (ADR-007)', () => {
  it('adds allow-same-origin only for a full-access page served from its own origin', async () => {
    const { container } = render(
      <HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} fullWebAccess principal="app:one" />,
    );
    await waitFor(() => expect(frame(container).getAttribute('src')).toBe(`${PAGE}/tok`));
    expect(frame(container).getAttribute('sandbox')).toBe('allow-scripts allow-modals allow-same-origin');
    expect(frame(container).hasAttribute('srcdoc')).toBe(false);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'put_artifact_frame',
      expect.objectContaining({ fullAccess: true, principal: 'app:one' }),
    );
  });

  it('keeps the opaque origin without full access or without a principal', async () => {
    const plain = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} principal="app:one" />);
    await waitFor(() => expect(frame(plain.container).getAttribute('src')).toBe('conduit-artifact://localhost/tok'));
    expect(frame(plain.container).getAttribute('sandbox')).toBe('allow-scripts');
    expect(ipc.invokeCommand).toHaveBeenCalledWith('put_artifact_frame', { html: expect.any(String) });
    plain.unmount();

    const anonymous = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} fullWebAccess />);
    await waitFor(() =>
      expect(frame(anonymous.container).getAttribute('src')).toBe('conduit-artifact://localhost/tok'),
    );
    expect(frame(anonymous.container).getAttribute('sandbox')).toBe('allow-scripts allow-modals');
  });

  it('never grants same-origin from the flags helper alone', () => {
    expect(artifactSandbox(false, true)).toBe('allow-scripts');
    expect(artifactSandbox(true, false)).toBe('allow-scripts allow-modals');
    expect(artifactSandbox(true, true)).not.toMatch(/popups|top-navigation|forms/);
  });

  it('takes messages only from the page origin and replies to that origin only', async () => {
    const handler = {
      request: vi.fn(async () => ({ ok: false as const, error: 'nope' })),
    };
    const { container } = render(
      <HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} fullWebAccess principal="app:one" network={handler} />,
    );
    await waitFor(() => expect(frame(container).getAttribute('src')).toBe(`${PAGE}/tok`));
    const iframe = frame(container);
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    const request = {
      type: ARTIFACT_FETCH_MESSAGE_TYPE,
      id: 3,
      url: 'https://api.example.com/x',
      method: 'GET',
      headers: [],
      body: null,
    };
    // The right window, but another origin (the frame navigated away).
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: request, source: iframe.contentWindow, origin: 'https://evil.example' }),
      );
    });
    expect(handler.request).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: request, source: iframe.contentWindow, origin: PAGE }));
    });
    expect(handler.request).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: 3, error: 'nope' }),
      PAGE,
    );
  });
});
