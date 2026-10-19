import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE, ARTIFACT_RUNTIME_ERROR_SCRIPT } from './runtimeError';

// The reporter runs inside the artifact frame and posts to `parent`; in jsdom
// the test window is its own parent, so a spy on postMessage sees each report.
function installReporter() {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  new Function(ARTIFACT_RUNTIME_ERROR_SCRIPT)();
  return post;
}

function failScriptLoad(attrs: { src: string; integrity?: string }) {
  const script = document.createElement('script');
  script.src = attrs.src;
  if (attrs.integrity) script.integrity = attrs.integrity;
  document.head.appendChild(script);
  script.dispatchEvent(new Event('error'));
  return script;
}

describe('artifact runtime error reporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('script').forEach((s) => s.remove());
  });

  it('names a script that failed to load and points at its integrity hash', () => {
    const post = installReporter();
    failScriptLoad({ src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', integrity: 'sha256-made-up' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({
      type: ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE,
      message: 'Could not load script https://unpkg.com/leaflet@1.9.4/dist/leaflet.js (its integrity hash may not match the file)',
      line: 0,
    });
  });

  it('reports the load failure, not the error it causes later', () => {
    const post = installReporter();
    failScriptLoad({ src: 'https://example.com/lib.js' });
    window.dispatchEvent(new ErrorEvent('error', { message: 'L is not defined', lineno: 12 }));
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0][0] as { message: string }).message).toBe('Could not load script https://example.com/lib.js');
  });
});
