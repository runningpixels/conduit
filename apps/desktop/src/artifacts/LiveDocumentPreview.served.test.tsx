import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inside Tauri: frames are served from the conduit-artifact scheme.
const core = vi.hoisted(() => ({
  isTauri: () => true,
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}));
const ipc = vi.hoisted(() => ({ invokeCommand: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);
vi.mock('../ipc/errors', () => ipc);

import { LiveDocumentPreview } from './LiveDocumentPreview';

let next = 0;
beforeEach(() => {
  vi.clearAllMocks();
  next = 0;
  ipc.invokeCommand.mockImplementation(async (command: string) =>
    command === 'put_artifact_frame' ? `t${++next}` : undefined,
  );
});

const source = (html: string) => () => ({
  toolName: 'write_html_document',
  argumentsText: JSON.stringify({ html }),
});

const frames = () => [...document.querySelectorAll('iframe')] as HTMLIFrameElement[];
const shown = () => document.querySelector('iframe[data-shown="true"]')?.getAttribute('src');

describe('LiveDocumentPreview served from the conduit-artifact scheme', () => {
  it('loads each update into the hidden frame and swaps it in on load', async () => {
    const { rerender } = render(<LiveDocumentPreview kind="html" readSource={source('<h1>One</h1>')} allowlist={[]} />);
    await act(async () => {});
    expect(frames()).toHaveLength(1);
    expect(shown()).toBe('conduit-artifact://localhost/t1');
    expect(frames()[0].hasAttribute('srcdoc')).toBe(false);
    fireEvent.load(frames()[0]);

    rerender(<LiveDocumentPreview kind="html" readSource={source('<h1>One</h1><p>Two</p>')} allowlist={[]} />);
    await act(async () => {});
    expect(frames()).toHaveLength(2);
    // The new document is in the hidden frame; the old one stays shown until it loads.
    expect(shown()).toBe('conduit-artifact://localhost/t1');
    const hidden = frames().find((f) => f.dataset.shown === 'false')!;
    expect(hidden.getAttribute('src')).toBe('conduit-artifact://localhost/t2');
    fireEvent.load(hidden);
    expect(shown()).toBe('conduit-artifact://localhost/t2');

    // Only real documents are served; the empty buffer never asks for a token.
    const put = ipc.invokeCommand.mock.calls.filter(([c]) => c === 'put_artifact_frame');
    expect(put).toHaveLength(2);
    expect(put[1][1].html).toContain('<p>Two</p>');
  });
});
