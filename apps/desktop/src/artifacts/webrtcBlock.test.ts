import { describe, expect, it } from 'vitest';
import { assembleArtifactDoc } from './HtmlArtifactRenderer';
import { ARTIFACT_WEBRTC_BLOCK_SCRIPT, ARTIFACT_WEBRTC_GLOBALS } from './webrtcBlock';

describe('ARTIFACT_WEBRTC_BLOCK_SCRIPT', () => {
  it('removes every WebRTC constructor and keeps it removed', () => {
    const win: Record<string, unknown> = {};
    for (const k of ARTIFACT_WEBRTC_GLOBALS) win[k] = function Fake() {};
    new Function('window', ARTIFACT_WEBRTC_BLOCK_SCRIPT)(win);
    for (const k of ARTIFACT_WEBRTC_GLOBALS) {
      expect(win[k]).toBeUndefined();
      // ES modules are strict, so writing a non-writable property throws.
      expect(() => {
        win[k] = function Again() {};
      }).toThrow();
      expect(Object.getOwnPropertyDescriptor(win, k)?.configurable).toBe(false);
    }
  });

  it('runs in the head before the other injected scripts and before model content', () => {
    const doc = assembleArtifactDoc('<script>new RTCPeerConnection()</script>', [], true, 'light', undefined, true);
    const block = doc.indexOf(ARTIFACT_WEBRTC_BLOCK_SCRIPT);
    expect(block).toBeGreaterThan(doc.indexOf('<meta http-equiv="Content-Security-Policy"'));
    expect(block).toBeLessThan(doc.indexOf('conduit:artifact-runtime-error'));
    expect(block).toBeLessThan(doc.indexOf('<body>'));
  });
});
