/// The deck frame: one static document that never reloads.
///
/// The deck itself (theme CSS and slide HTML) is posted into the frame by
/// message, so adding or editing a slide updates the live frame in place.
/// Nothing about a deck is interpolated into `DECK_FRAME_HTML`; the runtime is
/// a plain string, and everything it renders arrives over `postMessage`.
///
/// Frame to parent: `{type:'conduit-deck-event', event:'ready'}` once loaded,
/// and `{type:'conduit-deck-event', event:'select', slideId}` on a click.
/// Parent to frame: `deckMessage(...)`. The frame validates the shape, strips
/// scripts and inline handlers again (the sandbox is the boundary, this is
/// depth), and rebuilds only the slides whose HTML or layout changed.

import { withoutScripts } from '../artifacts/LiveDocumentPreview';
import type { DeckDetail } from '../ipc/contracts';

export const DECK_MESSAGE_TYPE = 'conduit-deck';
export const DECK_EVENT_TYPE = 'conduit-deck-event';

export type DeckViewMode = 'stage' | 'thumb';

export interface DeckView {
  mode: DeckViewMode;
  index: number;
}

export interface DeckMessage {
  type: typeof DECK_MESSAGE_TYPE;
  themeCss: string;
  slides: Array<{ id: string; layout: string; html: string }>;
  view: DeckView;
}

export type DeckFrameEvent = { event: 'ready' } | { event: 'select'; slideId: string };

export function deckMessage(deck: Pick<DeckDetail, 'themeCss' | 'slides'>, view: DeckView): DeckMessage {
  return {
    type: DECK_MESSAGE_TYPE,
    themeCss: deck.themeCss,
    slides: deck.slides.map((s) => ({ id: s.id, layout: s.layout, html: withoutScripts(s.html) })),
    view: { mode: view.mode, index: view.index },
  };
}

/** Reads a frame-to-parent message; null for anything that is not one of ours. */
export function parseDeckEvent(data: unknown): DeckFrameEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== DECK_EVENT_TYPE) return null;
  if (d.event === 'ready') return { event: 'ready' };
  if (d.event === 'select' && typeof d.slideId === 'string') return { event: 'select', slideId: d.slideId };
  return null;
}

const FRAME_STYLE = `
html, body { margin: 0; height: 100%; overflow: hidden; }
/* The letterbox around the 16:9 slide. Without an explicit colour the frame's
   canvas paints white, because its color-scheme differs from the app's. The
   values are the app's --bg in each mode (the frame cannot read app tokens). */
html { color-scheme: light; background: #f6f6f8; }
html[data-theme="dark"] { color-scheme: dark; background: #0b0d12; }
body { background: transparent; }
.deck-viewport { position: fixed; inset: 0; overflow: hidden; }
.deck { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; overflow: hidden; }
/* The slide's edge, for themes whose background is close to the letterbox.
   Drawn at 1920px scale, so it lands near one device pixel. */
body[data-mode="stage"] .deck { outline: 3px solid rgba(128, 128, 128, 0.28); }
.deck > .slide:not(.is-current) { display: none !important; }
.deck > .slide { position: absolute !important; left: 0; top: 0; }
body[data-mode="thumb"] { user-select: none; }
`;

const FRAME_SCRIPT = `
(function () {
  'use strict';
  var W = 1920, H = 1080;
  var viewport = document.querySelector('.deck-viewport');
  var deck = document.getElementById('deck');
  var themeEl = null;
  var themeCss = null;
  var nodes = {};
  var order = [];
  var index = 0;

  function post(payload) {
    payload.type = 'conduit-deck-event';
    try { parent.postMessage(payload, '*'); } catch (e) { /* no parent */ }
  }

  function fit() {
    var w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    var s = Math.min(w / W, h / H);
    deck.style.transform =
      'translate(' + (w - W * s) / 2 + 'px,' + (h - H * s) / 2 + 'px) scale(' + s + ')';
  }

  function valid(m) {
    if (!m || typeof m !== 'object' || m.type !== 'conduit-deck') return false;
    if (typeof m.themeCss !== 'string' || !Array.isArray(m.slides)) return false;
    if (!m.view || (m.view.mode !== 'stage' && m.view.mode !== 'thumb')) return false;
    if (typeof m.view.index !== 'number' || !isFinite(m.view.index)) return false;
    for (var i = 0; i < m.slides.length; i++) {
      var s = m.slides[i];
      if (!s || typeof s.id !== 'string' || typeof s.layout !== 'string' || typeof s.html !== 'string') return false;
    }
    return true;
  }

  function scrub(root) {
    var scripts = root.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var attrs = all[j].attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        if (/^on/i.test(attrs[k].name)) all[j].removeAttribute(attrs[k].name);
      }
    }
  }

  function build(slide) {
    var el = document.createElement('section');
    el.className = 'slide';
    el.setAttribute('data-slide', slide.id);
    el.setAttribute('data-layout', slide.layout);
    el.innerHTML = slide.html;
    scrub(el);
    return { el: el, layout: slide.layout, html: slide.html };
  }

  function apply(m) {
    if (themeCss !== m.themeCss) {
      if (!themeEl) {
        themeEl = document.createElement('style');
        themeEl.id = 'deck-theme';
        document.head.appendChild(themeEl);
      }
      themeEl.textContent = m.themeCss;
      themeCss = m.themeCss;
    }
    document.body.setAttribute('data-mode', m.view.mode);

    var next = {};
    var ids = [];
    for (var i = 0; i < m.slides.length; i++) {
      var s = m.slides[i];
      var prev = nodes[s.id];
      var node = prev && prev.layout === s.layout && prev.html === s.html ? prev : build(s);
      next[s.id] = node;
      ids.push(s.id);
    }
    for (var id in nodes) {
      if (!next[id] && nodes[id].el.parentNode) nodes[id].el.parentNode.removeChild(nodes[id].el);
    }
    for (var p = 0; p < ids.length; p++) {
      var want = next[ids[p]].el;
      if (deck.children[p] !== want) deck.insertBefore(want, deck.children[p] || null);
    }
    nodes = next;
    order = ids;

    index = Math.max(0, Math.min(order.length - 1, Math.floor(m.view.index)));
    for (var q = 0; q < order.length; q++) {
      nodes[order[q]].el.classList.toggle('is-current', q === index);
    }
    fit();
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    if (!valid(event.data)) return;
    apply(event.data);
  });
  window.addEventListener('resize', fit);
  deck.addEventListener('click', function (event) {
    var t = event.target;
    var slide = t && t.closest ? t.closest('.slide') : null;
    var id = slide && slide.getAttribute('data-slide');
    if (id) post({ event: 'select', slideId: id });
  });

  fit();
  post({ event: 'ready' });
})();
`;

/** Static body for `assembleArtifactDoc`. Contains no deck content. */
export const DECK_FRAME_HTML =
  `<style>${FRAME_STYLE}</style>` +
  `<div class="deck-viewport"><div class="deck" id="deck"></div></div>` +
  `<script>${FRAME_SCRIPT}</script>`;
