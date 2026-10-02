/// The deck frame: one static document that never reloads.
///
/// The deck itself (theme CSS and slide HTML) is posted into the frame by
/// message, so adding or editing a slide updates the live frame in place.
/// Nothing about a deck is interpolated into `DECK_FRAME_HTML`; the runtime is
/// a plain string, and everything it renders arrives over `postMessage`.
///
/// Frame to parent (all `{type:'conduit-deck-event', event, ...}`): `ready` once
/// loaded; `select {slideId}` on a click; in an editable stage `slot-select
/// {slideId,index,name}`, `slot-edit {slideId,index,name,html}` (commit of an
/// in-place edit), `key {key}` for navigation keys, and `overflow
/// {slides:[{id,px}]}` (stage only, only when the measurement changed).
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
  /** Stage only: slots can be selected and edited in place. */
  editable?: boolean;
}

export interface DeckMessage {
  type: typeof DECK_MESSAGE_TYPE;
  themeCss: string;
  slides: Array<{ id: string; layout: string; html: string }>;
  view: Required<DeckView>;
}

export type DeckFrameEvent =
  | { event: 'ready' }
  | { event: 'select'; slideId: string }
  | { event: 'slot-select'; slideId: string; index: number; name: string }
  | { event: 'slot-edit'; slideId: string; index: number; name: string; html: string }
  | { event: 'key'; key: string }
  | { event: 'overflow'; slides: Array<{ id: string; px: number }> };

export function deckMessage(deck: Pick<DeckDetail, 'themeCss' | 'slides'>, view: DeckView): DeckMessage {
  return {
    type: DECK_MESSAGE_TYPE,
    themeCss: deck.themeCss,
    slides: deck.slides.map((s) => ({ id: s.id, layout: s.layout, html: withoutScripts(s.html) })),
    view: { mode: view.mode, index: view.index, editable: view.mode === 'stage' && view.editable === true },
  };
}

/** Reads a frame-to-parent message; null for anything that is not one of ours. */
export function parseDeckEvent(data: unknown): DeckFrameEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== DECK_EVENT_TYPE) return null;
  if (d.event === 'ready') return { event: 'ready' };
  if (d.event === 'select' && typeof d.slideId === 'string') return { event: 'select', slideId: d.slideId };
  if (
    (d.event === 'slot-select' || d.event === 'slot-edit') &&
    typeof d.slideId === 'string' &&
    typeof d.name === 'string' &&
    typeof d.index === 'number' &&
    Number.isInteger(d.index) &&
    d.index >= 0
  ) {
    if (d.event === 'slot-select') return { event: 'slot-select', slideId: d.slideId, index: d.index, name: d.name };
    if (typeof d.html !== 'string') return null;
    return { event: 'slot-edit', slideId: d.slideId, index: d.index, name: d.name, html: d.html };
  }
  if (d.event === 'key' && typeof d.key === 'string') return { event: 'key', key: d.key };
  if (d.event === 'overflow' && Array.isArray(d.slides)) {
    const slides: Array<{ id: string; px: number }> = [];
    for (const s of d.slides) {
      if (!s || typeof s !== 'object') return null;
      const { id, px } = s as Record<string, unknown>;
      if (typeof id !== 'string' || typeof px !== 'number' || !Number.isFinite(px)) return null;
      slides.push({ id, px: Math.max(0, Math.round(px)) });
    }
    return { event: 'overflow', slides };
  }
  return null;
}

const INLINE_TAGS = new Set(['span', 'em', 'strong', 'b', 'i', 'u', 'br', 'sub', 'sup', 'small', 'mark']);
const DROP_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

/**
 * Reduces what a contenteditable produced to the inline HTML a slot may hold:
 * text plus `span em strong b i u br sub sup small mark`, `class` the only
 * attribute. `div`/`p` become line breaks, any other tag is unwrapped to its
 * text, and trailing breaks are trimmed. Mirrors the backend's allowlist.
 */
export function cleanInlineHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += escText((node.nodeValue ?? '').replace(/ /g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) return;
    if (tag === 'br') {
      out += '<br>';
    } else if (tag === 'div' || tag === 'p') {
      if (out !== '') out += '<br>';
      // An empty line is a lone <br> placeholder; the break above is the line.
      const only = el.childNodes.length === 1 && el.firstChild?.nodeName === 'BR';
      if (!only) el.childNodes.forEach(walk);
    } else if (INLINE_TAGS.has(tag)) {
      const cls = el.getAttribute('class');
      out += `<${tag}${cls ? ` class="${escAttr(cls)}"` : ''}>`;
      el.childNodes.forEach(walk);
      out += `</${tag}>`;
    } else {
      el.childNodes.forEach(walk);
    }
  };
  doc.body.childNodes.forEach(walk);
  return out.replace(/(?:<br>\s*)+$/, '');
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
/* Editing: text the user wrote is outlined; the slot being edited is ringed. */
body[data-editable="true"] [data-text] { cursor: text; }
body[data-editable="true"] [data-owner="user"] { outline: 2px dashed rgba(128, 128, 128, .55); outline-offset: 6px; }
body[data-editable="true"] [data-text]:hover { outline: 2px solid rgba(128, 128, 128, .45); outline-offset: 6px; }
body[data-editable="true"] [contenteditable="true"] { outline: 3px solid #5b8def; outline-offset: 6px; cursor: text; user-select: text; -webkit-user-select: text; }
`;

const FRAME_SCRIPT = `
(function () {
  'use strict';
  var W = 1920, H = 1080;
  var NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];
  var viewport = document.querySelector('.deck-viewport');
  var deck = document.getElementById('deck');
  var themeEl = null;
  var themeCss = null;
  var nodes = {};
  var order = [];
  var index = 0;
  var mode = 'stage';
  var editable = false;
  // The slot being edited: {slideId, index, name, el, original}. While set,
  // incoming renders leave that slide's node alone.
  var editing = null;
  var lastOverflow = null;

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
    return { el: el, layout: slide.layout, html: slide.html, px: null };
  }

  // Slots in document order; a slot inside another slot does not count.
  function slotsOf(section) {
    var all = section.querySelectorAll('[data-text]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var p = all[i].parentElement;
      if (!p || !p.closest || !section.contains(p.closest('[data-text]'))) out.push(all[i]);
    }
    return out;
  }

  function slotAt(target) {
    if (!target || !target.closest) return null;
    var el = target.closest('[data-text]');
    if (!el) return null;
    var section = el.closest('.slide');
    if (!section) return null;
    var list = slotsOf(section);
    for (var i = 0; i < list.length; i++) {
      if (list[i] === el || list[i].contains(el)) {
        return { slideId: section.getAttribute('data-slide'), index: i, name: list[i].getAttribute('data-text') || '', el: list[i] };
      }
    }
    return null;
  }

  function endEdit() {
    var e = editing;
    editing = null;
    if (e) e.el.removeAttribute('contenteditable');
    return e;
  }

  function cancelEdit() {
    var e = endEdit();
    if (e) e.el.innerHTML = e.original;
  }

  function commitEdit() {
    var e = endEdit();
    if (!e) return;
    var html = e.el.innerHTML;
    if (html === e.original) return;
    post({ event: 'slot-edit', slideId: e.slideId, index: e.index, name: e.name, html: html });
  }

  function startEdit(slot) {
    if (editing && editing.el === slot.el) return;
    if (editing) commitEdit();
    editing = { slideId: slot.slideId, index: slot.index, name: slot.name, el: slot.el, original: slot.el.innerHTML };
    slot.el.setAttribute('contenteditable', 'true');
    slot.el.focus();
  }

  // Overflow: how far a slide's content runs past 1920x1080. Hidden slides are
  // measured in place (hidden, but laid out) and restored, so nothing flashes.
  function measure(node) {
    var el = node.el;
    var saved = el.getAttribute('style');
    el.style.setProperty('display', 'block', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    var over = Math.max(el.scrollHeight - H, el.scrollWidth - W, 0);
    if (saved === null) el.removeAttribute('style'); else el.setAttribute('style', saved);
    return over;
  }

  function reportOverflow() {
    if (mode !== 'stage' || editing) return;
    var list = [];
    for (var i = 0; i < order.length; i++) {
      var node = nodes[order[i]];
      if (node.px === null) node.px = measure(node);
      list.push({ id: order[i], px: node.px });
    }
    var key = JSON.stringify(list);
    if (key === lastOverflow) return;
    lastOverflow = key;
    post({ event: 'overflow', slides: list });
  }

  function apply(m) {
    var themeChanged = themeCss !== m.themeCss;
    if (themeChanged) {
      if (!themeEl) {
        themeEl = document.createElement('style');
        themeEl.id = 'deck-theme';
        document.head.appendChild(themeEl);
      }
      themeEl.textContent = m.themeCss;
      themeCss = m.themeCss;
    }
    mode = m.view.mode;
    editable = mode === 'stage' && m.view.editable === true;
    document.body.setAttribute('data-mode', mode);
    document.body.setAttribute('data-editable', editable ? 'true' : 'false');
    if (!editable && editing) cancelEdit();

    var next = {};
    var ids = [];
    for (var i = 0; i < m.slides.length; i++) {
      var s = m.slides[i];
      var prev = nodes[s.id];
      var keep = prev && ((editing && editing.slideId === s.id) || (prev.layout === s.layout && prev.html === s.html));
      var node = keep ? prev : build(s);
      if (themeChanged) node.px = null;
      next[s.id] = node;
      ids.push(s.id);
    }
    // Drop every node that is no longer shown: slides that were deleted, and
    // the old node of a slide whose content changed (it was rebuilt above).
    for (var id in nodes) {
      var old = nodes[id].el;
      if ((!next[id] || next[id].el !== old) && old.parentNode) old.parentNode.removeChild(old);
    }
    if (editing && !next[editing.slideId]) editing = null;
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
    if (editing && order[index] !== editing.slideId) commitEdit();
    fit();
    reportOverflow();
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
    if (!editable) return;
    var slot = slotAt(t);
    if (slot) post({ event: 'slot-select', slideId: slot.slideId, index: slot.index, name: slot.name });
  });
  deck.addEventListener('dblclick', function (event) {
    if (!editable) return;
    var slot = slotAt(event.target);
    var cur = nodes[order[index]];
    if (slot && cur && cur.el.contains(slot.el)) startEdit(slot);
  });
  deck.addEventListener('focusout', function (event) {
    if (editing && event.target === editing.el) commitEdit();
  });
  deck.addEventListener('paste', function (event) {
    if (!editing) return;
    event.preventDefault();
    var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    if (text) document.execCommand('insertText', false, text);
  });
  document.addEventListener('keydown', function (event) {
    if (editing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) commitEdit();
        else document.execCommand('insertLineBreak');
      }
      return;
    }
    if (mode !== 'stage') return;
    if (NAV_KEYS.indexOf(event.key) >= 0 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      post({ event: 'key', key: event.key });
    } else if ((event.ctrlKey || event.metaKey) && (event.key === 'h' || event.key === 'H')) {
      event.preventDefault();
      post({ event: 'key', key: 'Ctrl+H' });
    }
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
