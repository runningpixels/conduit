/// Auto-fit: shrink what does not fit a slide, within floors, so a layout
/// holds whatever length of text arrives.
///
/// One plain ES5 source shared by every place a slide is drawn: the deck frame
/// (stage, thumbnails, presenting), the exported HTML and the PDF print
/// document. It defines one global, `conduitFit`. The decisions are pure
/// functions of measurements (tested by evaluating this source); the DOM glue
/// around them only measures and applies.
///
/// Every size the fit sets is an inline `!important` declaration on the
/// element it shrinks, so it beats the model's own inline styles. The element's
/// original `style` attribute is kept on an expando, so `unfit` restores it
/// exactly and `cleanSlotHtml` can read a slot without any fitted size: fitted
/// sizes live only in the drawn DOM and are never saved back into slide HTML.

export const DECK_FIT_SCRIPT = `
var conduitFit = (function () {
  'use strict';
  var W = 1920, H = 1080;
  // A few pixels over (descenders, outlines) is not worth a warning.
  var TOLERANCE = 16;
  var STAT_FLOOR = 64;
  var SVG_FLOOR = 240;
  var DENSE_ROUNDS = 8;
  // Whole-slide shrinking: [selector, floor px].
  var DENSE_FLOORS = [['.headline', 56], ['.sub', 34], ['.body', 30], ['ul.bullets', 32], ['.quote', 44], ['.col', 28]];

  // --- Decisions (pure) ---

  // A stat value is one line that fits its column. Shrink 10% a step down to
  // the floor; only at the floor may it wrap. null: leave it.
  function nextStatSize(size, wide, lines) {
    if (!wide && lines <= 1) return null;
    if (size <= STAT_FLOOR) return null;
    return Math.max(STAT_FLOOR, size * 0.9);
  }

  // A slot holding a token wider than its box shrinks, to half its size at most.
  function nextSlotSize(size, base, wide) {
    var floor = base * 0.5;
    if (!wide || size <= floor) return null;
    return Math.max(floor, size * 0.9);
  }

  // One whole-slide round: 6% smaller, never below the floor.
  function denseSize(size, floor) {
    return size > floor ? Math.max(floor, size * 0.94) : size;
  }

  // One whole-slide round for an in-flow drawing's height.
  function denseSvgHeight(height) {
    return Math.max(SVG_FLOOR, height * 0.9);
  }

  // How far a slide's content runs past the canvas, in canvas px. box is the
  // union of the slide's children (slide coordinates); scrollW/scrollH are the
  // slide's scroll extents, which also see descendants spilling out of a child.
  function overflowPx(box, scrollW, scrollH) {
    var over = Math.max(scrollH - H, scrollW - W, 0);
    if (box) over = Math.max(over, -box.top, -box.left, box.bottom - H, box.right - W);
    return over > TOLERANCE ? over : 0;
  }

  // --- DOM glue ---

  function px(el) { return parseFloat(getComputedStyle(el).fontSize) || 0; }

  // Canvas px per rendered px: the slide may sit under a scale transform.
  function scaleOf(slide) {
    var w = slide.getBoundingClientRect().width;
    return w > 0 ? w / W : 0;
  }

  function set(slide, el, prop, value) {
    if (!el.__conduitFit) {
      el.__conduitFit = { style: el.getAttribute('style'), base: px(el) };
      (slide.__conduitFitted || (slide.__conduitFitted = [])).push(el);
    }
    el.style.setProperty(prop, value + 'px', 'important');
  }

  // Grid and flex items grow to their content, so compare with the
  // container's box as well as the element's own.
  function wide(el) {
    var room = el.clientWidth;
    if (el.parentElement) room = Math.min(room, el.parentElement.clientWidth);
    return el.scrollWidth > room + 1;
  }

  function lines(el) {
    var cs = getComputedStyle(el);
    var lh = parseFloat(cs.lineHeight);
    if (!(lh > 0)) lh = (parseFloat(cs.fontSize) || 1) * 1.2;
    return Math.round(el.offsetHeight / lh);
  }

  // Union of the slide's children's boxes, in slide coordinates; null when
  // nothing is laid out.
  function extent(slide) {
    var s = scaleOf(slide);
    if (!s) return null;
    var origin = slide.getBoundingClientRect();
    var box = null;
    for (var i = 0; i < slide.children.length; i++) {
      var r = slide.children[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      var b = { left: (r.left - origin.left) / s, top: (r.top - origin.top) / s, right: (r.right - origin.left) / s, bottom: (r.bottom - origin.top) / s };
      if (!box) box = b;
      else box = { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) };
    }
    return box;
  }

  function overflow(slide) {
    return overflowPx(extent(slide), slide.scrollWidth, slide.scrollHeight);
  }

  function runsOff(slide) {
    var box = extent(slide);
    return slide.scrollHeight > H + 1 || (box !== null && (box.bottom > H + 1 || box.top < -1));
  }

  // In-flow drawings, the ones whose height can give: top-level svgs and
  // figures (their inner svg is the box that shrinks). Absolutely placed
  // visuals, such as image-left's, are in their own column.
  function flowDrawings(slide) {
    var out = [];
    for (var i = 0; i < slide.children.length; i++) {
      var c = slide.children[i];
      var tag = c.tagName.toLowerCase();
      if ((tag !== 'svg' && tag !== 'figure') || getComputedStyle(c).position === 'absolute') continue;
      var svg = tag === 'svg' ? c : c.querySelector(':scope > svg');
      if (svg) out.push(svg);
    }
    return out;
  }

  // Shrinks what does not fit. The slide must be laid out (shown or measuring).
  // Returns false when it is not laid out, so the caller can try again later.
  function fitSlide(slide) {
    var scale = scaleOf(slide);
    if (!scale) return false;
    var steps = 0, i, k, next;

    // 1. Stat values: one line that fits its column; one size per slide.
    var stats = slide.querySelectorAll('.stat > b, .stat > strong');
    var least = Infinity;
    for (i = 0; i < stats.length; i++) {
      var b = stats[i], size = px(b);
      for (k = 0; k < 16; k++) {
        next = nextStatSize(size, wide(b), lines(b));
        if (next === null) break;
        size = next; set(slide, b, 'font-size', size); steps++;
      }
      least = Math.min(least, size);
    }
    for (i = 0; i < stats.length; i++) {
      if (px(stats[i]) > least + 0.5) { set(slide, stats[i], 'font-size', least); steps++; }
    }

    // 2. A block slot holding a token wider than itself. Text inside an svg
    // is in the drawing's own units and scales with the drawing: never here.
    var slots = slide.querySelectorAll('[data-text]');
    for (i = 0; i < slots.length; i++) {
      var t = slots[i];
      if (t.closest('svg') || getComputedStyle(t).display === 'inline') continue;
      var f = px(t), base = t.__conduitFit ? t.__conduitFit.base : f;
      for (k = 0; k < 10; k++) {
        next = nextSlotSize(f, base, wide(t));
        if (next === null) break;
        f = next; set(slide, t, 'font-size', f); steps++;
      }
    }

    // 3. The slide as a whole still runs off the bottom (safe centering keeps
    // it off the top): text and in-flow drawings give a little each round.
    var rounds = 0;
    while (rounds < DENSE_ROUNDS && runsOff(slide)) {
      for (var q = 0; q < DENSE_FLOORS.length; q++) {
        var list = slide.querySelectorAll(DENSE_FLOORS[q][0]);
        for (k = 0; k < list.length; k++) {
          var was = px(list[k]), now = denseSize(was, DENSE_FLOORS[q][1]);
          if (now < was) set(slide, list[k], 'font-size', now);
        }
      }
      var drawings = flowDrawings(slide);
      for (k = 0; k < drawings.length; k++) {
        var h = drawings[k].getBoundingClientRect().height / scale;
        if (h > SVG_FLOOR) set(slide, drawings[k], 'max-height', denseSvgHeight(h));
      }
      rounds++;
    }
    steps += rounds;
    if (steps) slide.setAttribute('data-fit', String(steps));
    if (rounds) slide.setAttribute('data-fit-dense', String(rounds));
    return true;
  }

  // Restores every element the fit touched to its own style attribute.
  function unfit(slide) {
    var list = slide.__conduitFitted || [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i], orig = el.__conduitFit ? el.__conduitFit.style : null;
      if (orig === null) el.removeAttribute('style'); else el.setAttribute('style', orig);
      el.__conduitFit = null;
    }
    slide.__conduitFitted = [];
    slide.removeAttribute('data-fit');
    slide.removeAttribute('data-fit-dense');
  }

  // A slot's inner HTML as written: descendants the fit shrank carry their
  // original style attribute. (The slot's own style is not in its innerHTML.)
  function cleanSlotHtml(slot) {
    var clone = slot.cloneNode(true);
    var from = slot.querySelectorAll('*'), to = clone.querySelectorAll('*');
    for (var i = 0; i < from.length && i < to.length; i++) {
      var fit = from[i].__conduitFit;
      if (!fit) continue;
      if (fit.style === null) to[i].removeAttribute('style'); else to[i].setAttribute('style', fit.style);
    }
    return clone.innerHTML;
  }

  return {
    nextStatSize: nextStatSize,
    nextSlotSize: nextSlotSize,
    denseSize: denseSize,
    denseSvgHeight: denseSvgHeight,
    overflowPx: overflowPx,
    fitSlide: fitSlide,
    unfit: unfit,
    overflow: overflow,
    cleanSlotHtml: cleanSlotHtml
  };
})();
`;
