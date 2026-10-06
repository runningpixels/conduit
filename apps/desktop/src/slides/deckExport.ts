/// Deck export documents. Pure string builders, no DOM.
///
/// `buildDeckHtmlExport` is one self-contained file that presents itself in any
/// browser (no network, no external resources). `buildDeckPrintHtml` is every
/// slide stacked, one 1920x1080 page each, which Rust prints to a PDF.
/// Slide HTML goes through `withoutScripts` (scripts and inline handlers), the
/// same as the stage; the deck's theme CSS is the one the stage uses.
///
/// Both documents carry the stage's auto-fit (`DECK_FIT_SCRIPT`, one shared
/// source) so they look like the stage. The print document allows exactly
/// that script, by a fresh nonce; slide content can run nothing.

import { withoutScripts } from '../artifacts/LiveDocumentPreview';
import type { DeckDetail } from '../ipc/contracts';
import { DECK_FIT_SCRIPT } from './deckFit';

type ExportDeck = Pick<DeckDetail, 'title' | 'themeCss'> & {
  slides: ReadonlyArray<Pick<DeckDetail['slides'][number], 'layout' | 'html' | 'notes'>>;
};

export interface DeckHtmlOptions {
  /** Interface language, written to `<html lang>` when it is a plain tag. */
  lang?: string;
  /** Product name for `<meta name="generator">`. */
  generator: string;
}

/** The export's own policy: inline style and script, data images and fonts, nothing else. */
export const EXPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
/**
 * The print document's policy: only the script carrying this nonce runs (the
 * auto-fit); no inline script or handler from slide content can.
 */
export const printCsp = (nonce: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;

/** 128 random bits, base64url: unguessable by content written before the export. */
function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const LANG_REGEX = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');
/** Theme CSS sits inside a <style> element: it must not be able to close it. */
const safeCss = (css: string) => css.replace(/<\/style/gi, '<\\/style');

const langAttr = (lang?: string) => (lang && LANG_REGEX.test(lang) ? ` lang="${lang}"` : '');

const BASE_CSS = `
html, body { margin: 0; height: 100%; }
`;

const HTML_CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
.deck-viewport { position: fixed; inset: 0; overflow: auto; }
.deck { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; overflow: hidden; }
.cell { display: none; position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
.cell.is-current { display: block; }
.cell > .slide { position: absolute !important; left: 0; top: 0; }
.cell > aside.notes { display: none; }
body.overview .deck-viewport { overflow: auto; }
body.overview .deck { position: static; width: auto; height: auto; transform: none !important; overflow: visible;
  display: grid; grid-template-columns: repeat(auto-fill, 320px); gap: 20px; padding: 28px; justify-content: center; }
body.overview .cell { display: block; position: relative; width: 320px; height: 180px; overflow: hidden; cursor: pointer;
  outline: 2px solid rgba(255, 255, 255, 0.18); }
body.overview .cell.is-current { outline: 3px solid #5b8def; }
body.overview .cell > .slide { transform: scale(0.16667); transform-origin: 0 0; pointer-events: none; }
.deck-counter { position: fixed; right: 16px; bottom: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(0, 0, 0, 0.6);
  color: #fff; font: 600 14px/1.4 system-ui, sans-serif; opacity: 0; transition: opacity 0.4s; pointer-events: none; }
.deck-counter.on { opacity: 1; }
.deck-notes { position: fixed; left: 0; right: 0; bottom: 0; max-height: 40%; overflow: auto; box-sizing: border-box; padding: 18px 28px;
  background: rgba(10, 10, 14, 0.92); color: #f2f2f5; font: 20px/1.5 system-ui, sans-serif; white-space: pre-wrap; display: none; }
body.show-notes .deck-notes { display: block; }
`;

/// Plain ES5 so any browser runs it; no template placeholders inside.
const HTML_SCRIPT = `
(function () {
  'use strict';
  var W = 1920, H = 1080;
  var body = document.body;
  var viewport = document.getElementById('viewport');
  var deck = document.getElementById('deck');
  var counter = document.getElementById('counter');
  var notesEl = document.getElementById('notes');
  var cells = Array.prototype.slice.call(deck.children);
  var n = cells.length;
  var index = 0;
  var fade = null;

  function fit() {
    var w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    var s = Math.min(w / W, h / H);
    deck.style.transform = 'translate(' + (w - W * s) / 2 + 'px,' + (h - H * s) / 2 + 'px) scale(' + s + ')';
  }

  function flash() {
    counter.classList.add('on');
    if (fade) clearTimeout(fade);
    fade = setTimeout(function () { counter.classList.remove('on'); }, 1800);
  }

  function show(k, fromHash) {
    if (!n) return;
    index = Math.max(0, Math.min(n - 1, k));
    for (var i = 0; i < n; i++) cells[i].classList.toggle('is-current', i === index);
    counter.textContent = (index + 1) + ' / ' + n;
    var aside = cells[index].querySelector('aside.notes');
    notesEl.textContent = aside ? aside.textContent : '';
    if (!fromHash) {
      try { history.replaceState(null, '', '#' + (index + 1)); } catch (e) { /* file origin may refuse */ }
    }
    flash();
  }

  function fromLocation() {
    var m = /^#(\\d+)$/.exec(location.hash);
    show(m ? parseInt(m[1], 10) - 1 : 0, true);
  }

  function toggle(cls) { body.classList.toggle(cls); }

  function fullscreen() {
    try {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        var p = document.documentElement.requestFullscreen();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) { /* not available */ }
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'ArrowDown') show(index + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'ArrowUp') show(index - 1);
    else if (k === 'Home') show(0);
    else if (k === 'End') show(n - 1);
    else if (k === 'f' || k === 'F') fullscreen();
    else if (k === 'n' || k === 'N') toggle('show-notes');
    else if (k === 'o' || k === 'O') toggle('overview');
    else if (k === 'Escape') { body.classList.remove('overview'); body.classList.remove('show-notes'); return; }
    else return;
    e.preventDefault();
  });

  deck.addEventListener('click', function (e) {
    if (body.classList.contains('overview')) {
      var t = e.target;
      while (t && t !== deck && t.parentNode !== deck) t = t.parentNode;
      var at = cells.indexOf(t);
      if (at >= 0) { show(at); body.classList.remove('overview'); }
      return;
    }
    show(index + 1);
  });
  deck.addEventListener('contextmenu', function (e) {
    if (body.classList.contains('overview')) return;
    e.preventDefault();
    show(index - 1);
  });
  document.addEventListener('mousemove', flash);
  window.addEventListener('resize', fit);
  window.addEventListener('hashchange', fromLocation);

  // Auto-fit every slide, as the stage does: each cell is laid out hidden
  // for the measurement. Again once any theme fonts have loaded.
  function fitSlides(again) {
    for (var i = 0; i < n; i++) {
      var slide = cells[i].querySelector('.slide');
      if (!slide) continue;
      var saved = cells[i].getAttribute('style');
      cells[i].style.display = 'block';
      cells[i].style.visibility = 'hidden';
      try {
        if (again) conduitFit.unfit(slide);
        conduitFit.fitSlide(slide);
      } catch (e) { /* never block presenting */ }
      if (saved === null) cells[i].removeAttribute('style'); else cells[i].setAttribute('style', saved);
    }
  }

  fit();
  fitSlides(false);
  if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(function () { fitSlides(true); });
  fromLocation();
})();
`;

/// The print document fits its slides once laid out; the window waits for
/// the load event and a settle delay before printing.
const PRINT_FIT_SCRIPT = `
(function () {
  function fitSlides(again) {
    var slides = document.querySelectorAll('.deck > .slide');
    for (var i = 0; i < slides.length; i++) {
      try {
        if (again) conduitFit.unfit(slides[i]);
        conduitFit.fitSlide(slides[i]);
      } catch (e) { /* print what there is */ }
    }
  }
  fitSlides(false);
  if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(function () { fitSlides(true); });
})();
`;

function themeStyle(css: string): string {
  return `<style id="deck-theme">${safeCss(css)}</style>`;
}

/** One slide's content, scripts and inline handlers removed. */
function slideInner(html: string): string {
  return withoutScripts(html);
}

/** A complete standalone document that presents the deck in any browser. */
export function buildDeckHtmlExport(deck: ExportDeck, options: DeckHtmlOptions): string {
  const cells = deck.slides
    .map((slide) => {
      const notes = slide.notes.trim() === '' ? '' : `<aside class="notes">${escText(slide.notes)}</aside>`;
      return (
        `<div class="cell"><section class="slide" data-layout="${escAttr(slide.layout)}">${slideInner(slide.html)}</section>${notes}</div>`
      );
    })
    .join('');
  return (
    `<!doctype html><html${langAttr(options.lang)}><head>` +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="generator" content="${escAttr(options.generator)}">` +
    `<title>${escText(deck.title)}</title>` +
    themeStyle(deck.themeCss) +
    `<style>${HTML_CSS}</style>` +
    `</head><body>` +
    `<div class="deck-viewport" id="viewport"><div class="deck" id="deck">${cells}</div></div>` +
    `<div class="deck-counter" id="counter" aria-hidden="true"></div>` +
    `<div class="deck-notes" id="notes"></div>` +
    `<script>${DECK_FIT_SCRIPT}${HTML_SCRIPT}</script>` +
    `</body></html>`
  );
}

const PRINT_CSS = `
@page { size: 1920px 1080px; margin: 0; }
html, body { margin: 0; padding: 0; width: 1920px; background: #fff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.deck { display: block; width: 1920px; }
.deck > .slide { position: relative !important; width: 1920px; height: 1080px; overflow: hidden;
  break-after: page; break-inside: avoid; page-break-after: always;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.deck > .slide:last-child { break-after: auto; page-break-after: auto; }
`;

/**
 * Every slide stacked, each exactly one page. The only script is the auto-fit,
 * allowed by `nonce` (fresh per document unless a test passes one).
 */
export function buildDeckPrintHtml(deck: ExportDeck, nonce: string = freshNonce()): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error('print nonce must be 16+ base64url characters');
  const slides = deck.slides
    .map((slide) => `<section class="slide" data-layout="${escAttr(slide.layout)}">${slideInner(slide.html)}</section>`)
    .join('');
  return (
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${printCsp(nonce)}">` +
    `<meta charset="utf-8">` +
    `<title>${escText(deck.title)}</title>` +
    `<style>${BASE_CSS}</style>` +
    themeStyle(deck.themeCss) +
    `<style>${PRINT_CSS}</style>` +
    `</head><body><div class="deck">${slides}</div>` +
    `<script nonce="${escAttr(nonce)}">${DECK_FIT_SCRIPT}${PRINT_FIT_SCRIPT}</script>` +
    `</body></html>`
  );
}
