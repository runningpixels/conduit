/// The layout check: what a viewer would see is wrong on a slide, measured in
/// the deck frame after the auto-fit has run.
///
/// Plain ES5 source run inside the stage frame (`deckDocument.ts`); it defines
/// one global, `conduitLayout`. The thresholds were tuned against screenshots
/// of real model-built decks; checks that fired on slides that looked fine
/// (text near the edge, small but legible text, shrunk stat values) are left
/// out. The decisions are pure functions of measurements (tested by evaluating
/// this source); `check` only measures.
///
/// `check(slide)` returns `{dense, minFont, issues}`, or null when the slide
/// is not laid out. Issues (slide coordinates, canvas px):
/// - `{kind:'overlap', slots:[a,b]}`: two text slots' glyphs overlap;
/// - `{kind:'clipped', slot, by}`: a slot's text runs past the slide edge;
/// - `{kind:'svg-small-text', px, viewBox, width, height, scale}`: the
///   smallest label in a drawing renders below 18px;
/// - `{kind:'svg-empty', pct, width, height}`: a large drawing box is mostly
///   empty (its viewBox does not match the box's shape);
/// - `{kind:'svg-clipped', by}`: a drawing runs past the slide edge.

export const DECK_LAYOUT_SCRIPT = `
var conduitLayout = (function () {
  'use strict';
  var W = 1920, H = 1080;
  // data-fit-dense rounds at which a slide counts as too full.
  var DENSE_ROUNDS = 3;
  // Display type pokes a few px past its box without anything visibly cut.
  var EDGE_SLACK = 4;
  var SVG_MIN_TEXT = 18;
  var SVG_MIN_FILL = 20;
  var SVG_BIG_BOX = 0.15 * W * H;

  // --- Decisions (pure) ---

  function intersect(a, b) {
    return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  }

  // Two text boxes visibly run into each other: more than 400 px² that is
  // also more than 4% of the smaller one.
  function overlaps(a, b) {
    var ov = intersect(a, b);
    var small = Math.min(a.w * a.h, b.w * b.h) || 1;
    return ov > 400 && ov / small > 0.04;
  }

  // How far a box runs past the slide edge, in px; 0 within the slack.
  function outside(b) {
    var out = Math.max(-b.x, -b.y, b.x + b.w - W, b.y + b.h - H);
    return out > EDGE_SLACK ? Math.round(out) : 0;
  }

  // The box a slot's text occupies: its glyphs horizontally; vertically the
  // line box, because tight display type (line-height 1) has ink past the
  // line box without anything touching, unless the text clearly spills out.
  function textBox(glyph, line, font) {
    if (glyph.h <= line.h + 0.45 * font) return { x: glyph.x, y: line.y, w: glyph.w, h: line.h };
    return glyph;
  }

  // Rendered px per viewBox unit (preserveAspectRatio meet); 1 without a viewBox.
  function svgScale(box, viewBox) {
    if (!viewBox || !(viewBox.w > 0) || !(viewBox.h > 0)) return 1;
    return Math.min(box.w / viewBox.w, box.h / viewBox.h);
  }

  function svgTextTooSmall(px) { return px < SVG_MIN_TEXT; }

  // Only a drawing given a large box is worth a line when mostly empty.
  function svgMostlyEmpty(drawingPct, box) {
    return box.w * box.h > SVG_BIG_BOX && drawingPct < SVG_MIN_FILL;
  }

  function dense(rounds) { return rounds >= DENSE_ROUNDS; }

  // --- DOM glue ---

  function check(slide) {
    var sr = slide.getBoundingClientRect();
    if (!sr.width) return null;
    var k = sr.width / W;
    function box(r) {
      return { x: Math.round((r.left - sr.left) / k), y: Math.round((r.top - sr.top) / k),
        w: Math.round(r.width / k), h: Math.round(r.height / k) };
    }
    var issues = [];
    var texts = [];
    var minFont = 0;
    var all = slide.querySelectorAll('[data-text]');
    var i, j;
    // Text leaves: slots with no slot inside. Their glyph extent comes from a
    // Range, so text spilling out of its own box is caught.
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.querySelector('[data-text]') || !(el.textContent || '').trim()) continue;
      var r = el.getBoundingClientRect();
      if (!r.width) continue;
      var range = document.createRange();
      range.selectNodeContents(el);
      var font = parseFloat(getComputedStyle(el).fontSize) || 0;
      var inSvg = !!(el.closest && el.closest('svg'));
      texts.push({ el: el, name: el.getAttribute('data-text') || el.tagName.toLowerCase(),
        box: textBox(box(range.getBoundingClientRect()), box(r), font), inSvg: inSvg });
      if (!inSvg && font > 0) minFont = minFont ? Math.min(minFont, font) : font;
    }
    for (i = 0; i < texts.length; i++) {
      var by = outside(texts[i].box);
      if (by) issues.push({ kind: 'clipped', slot: texts[i].name, by: by });
    }
    var seen = {};
    for (i = 0; i < texts.length; i++) {
      for (j = i + 1; j < texts.length; j++) {
        var a = texts[i], b = texts[j];
        if (a.el.contains(b.el) || b.el.contains(a.el) || !overlaps(a.box, b.box)) continue;
        var key = a.name + '\\n' + b.name;
        if (seen[key]) continue;
        seen[key] = true;
        issues.push({ kind: 'overlap', slots: [a.name, b.name] });
      }
    }
    var svgs = slide.querySelectorAll('svg');
    for (i = 0; i < svgs.length; i++) {
      var s = svgs[i];
      if (s.parentElement && s.parentElement.closest && s.parentElement.closest('svg')) continue;
      var sb = box(s.getBoundingClientRect());
      if (!sb.w || !sb.h) continue;
      var out = outside(sb);
      if (out) issues.push({ kind: 'svg-clipped', by: out });
      var vb = s.viewBox && s.viewBox.baseVal && s.viewBox.baseVal.width
        ? { w: s.viewBox.baseVal.width, h: s.viewBox.baseVal.height } : null;
      var scale = svgScale(sb, vb);
      try {
        var bb = s.getBBox();
        var pct = Math.round(100 * (bb.width * scale) * (bb.height * scale) / Math.max(1, sb.w * sb.h));
        if (svgMostlyEmpty(pct, sb)) issues.push({ kind: 'svg-empty', pct: pct, width: sb.w, height: sb.h });
      } catch (e) { /* not rendered */ }
      var labels = s.querySelectorAll('text');
      var least = Infinity;
      for (j = 0; j < labels.length; j++) {
        var f = parseFloat(getComputedStyle(labels[j]).fontSize) || parseFloat(labels[j].getAttribute('font-size') || '');
        if (f > 0) least = Math.min(least, f * scale);
      }
      if (least < Infinity && svgTextTooSmall(least)) {
        issues.push({ kind: 'svg-small-text', px: Math.round(least), viewBox: s.getAttribute('viewBox') || '',
          width: sb.w, height: sb.h, scale: Math.round(scale * 100) / 100 });
      }
    }
    return { dense: dense(Number(slide.getAttribute('data-fit-dense') || 0)), minFont: Math.round(minFont), issues: issues };
  }

  return {
    intersect: intersect,
    overlaps: overlaps,
    outside: outside,
    textBox: textBox,
    svgScale: svgScale,
    svgTextTooSmall: svgTextTooSmall,
    svgMostlyEmpty: svgMostlyEmpty,
    dense: dense,
    check: check
  };
})();
`;
