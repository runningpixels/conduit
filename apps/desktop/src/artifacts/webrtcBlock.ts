/// WebRTC removal for HTML artifacts — defence in depth only.
///
/// Chromium does not apply CSP to WebRTC: with `connect-src 'none'` an artifact
/// could still open an `RTCPeerConnection` and send data it chose to any host
/// through STUN/TURN (verified live 2026-09-28). The real fix is at the WebView
/// level (`additionalBrowserArgs` in tauri.conf.json: no non-proxied UDP, and a
/// dead proxy so TCP has nowhere to go). This script only removes the
/// constructors from the artifact's own window, before any model script runs,
/// so the common case fails fast instead of relying on the network layer alone.
/// A removal inside the page's own realm is not a boundary by itself.

export const ARTIFACT_WEBRTC_GLOBALS = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
] as const;

/// Trusted (Conduit-owned). Must run first in the head, before model content.
export const ARTIFACT_WEBRTC_BLOCK_SCRIPT =
  `(function(){var k=${JSON.stringify(ARTIFACT_WEBRTC_GLOBALS)};` +
  `for(var i=0;i<k.length;i++){try{Object.defineProperty(window,k[i],{value:undefined,writable:false,configurable:false});}catch(e){}}` +
  `})();`;
