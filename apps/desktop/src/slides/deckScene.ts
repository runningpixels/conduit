/// The scene: what a laid-out slide looks like, as a flat list of things to
/// draw, for the PowerPoint export (`deck_pptx_scene.rs`).
///
/// Plain ES5 source run inside the deck frame (`deckDocument.ts`), like the
/// auto-fit and the layout check; it defines one global, `conduitScene`.
/// `capture(slide)` walks a fitted slide and returns `{bg, bgSvg, items}` in
/// slide pixels (1920x1080), in paint order:
/// - `shape {x,y,w,h,radius,fill,line,shadow?}`: a box with a solid or linear fill
///   and/or a uniform border (one-sided borders arrive as thin filled shapes)
///   and its first outer box-shadow;
/// - `picture {x,y,w,h,svg}`: a drawing, with every computed style inlined so
///   it stands alone, or a box whose background PowerPoint can't express
///   (radial or layered gradients), drawn as svg;
/// - `chart {x,y,w,h,index}`: the slide's `index`-th `svg[data-chart]`, which
///   the export draws as a native chart from the stored spec;
/// - `text {x,y,w,h,title,paras}`: one block of text at its content box. Each
///   paragraph carries its alignment and line height; each run its font,
///   size, weight, colour and spacing. A `\n` in a run is a line break: one
///   the slide had (`<br>`), or, for `text-wrap: balance` blocks, where the
///   browser wrapped (PowerPoint does not balance lines).
/// Pseudo-elements (accent bars, bullet squares, quote marks) are measured by
/// standing a real element in for each one while the scene is taken; the
/// slide is restored before `capture` returns.
/// Colours are `#rrggbbaa` with the element's opacity folded in.

export interface SceneRun {
  text: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  underline: boolean;
  strike: boolean;
  spacing: number;
  caps: boolean;
  baseline: number;
  glow?: { radius: number; color: string };
}

export interface ScenePara {
  align: 'l' | 'ctr' | 'r' | 'just';
  lineHeight: number;
  runs: SceneRun[];
}

export type SceneFill =
  | { type: 'solid'; color: string }
  | { type: 'linear'; angle: number; stops: Array<{ pos: number; color: string }> };

export type SceneItem =
  | { kind: 'shape'; x: number; y: number; w: number; h: number; radius: number; fill: SceneFill | null;
      line: { width: number; color: string; dash: boolean } | null;
      shadow?: { x: number; y: number; blur: number; color: string } }
  | { kind: 'picture'; x: number; y: number; w: number; h: number; svg: string }
  | { kind: 'chart'; x: number; y: number; w: number; h: number; index: number }
  | { kind: 'text'; x: number; y: number; w: number; h: number; title: boolean; paras: ScenePara[] };

export interface SlideScene {
  bg: string;
  bgSvg: string | null;
  items: SceneItem[];
}

export const DECK_SCENE_SCRIPT = `
var conduitScene = (function () {
  'use strict';
  var W = 1920, H = 1080;
  var MAX_ITEMS = 1500;
  var MAX_SVG = 2000000;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var INLINE = { inline: 1, contents: 1 };
  // Styles inlined into a drawing so it renders the same outside the deck.
  var SVG_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor',
    'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'visibility', 'display', 'stop-color',
    'stop-opacity', 'paint-order', 'text-decoration'];

  // --- Colours ---

  var probe = null;
  function hex2(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length < 2 ? '0' + s : s; }
  // Any computed colour as [r, g, b, a]; null when it can't be read.
  function rgba(value) {
    if (!value) return null;
    var m = /^rgba?\\(([^)]*)\\)$/.exec(value.trim());
    if (m) {
      var p = m[1].split(/[\\s,\\/]+/).filter(function (s) { return s !== ''; });
      if (p.length < 3) return null;
      var a = p.length > 3 ? (p[3].slice(-1) === '%' ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
      return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), isNaN(a) ? 1 : a];
    }
    if (value === 'transparent') return [0, 0, 0, 0];
    // Only something CSS reads as a colour: a size like 1100px is not one.
    if (!window.CSS || !CSS.supports('color', value)) return null;
    // Other colour spaces (oklch, color(...)): let a canvas convert it.
    try {
      if (!probe) { probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); probe.canvas.width = probe.canvas.height = 1; }
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = '#000';
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      var d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch (e) { return null; }
  }
  function hex(c, opacity) {
    var a = c[3] * (opacity == null ? 1 : opacity);
    return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + hex2(a * 255);
  }
  function cssColor(c, opacity) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (c[3] * (opacity == null ? 1 : opacity)).toFixed(4) + ')';
  }

  // --- Gradients ---

  // Split on commas outside parentheses.
  function splitTop(s) {
    var out = [], depth = 0, start = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out.filter(function (x) { return x !== ''; });
  }
  // background-image layers: [{type, args}] for gradients; null when a layer
  // is something else (url(), conic), which the scene can't redraw.
  function layers(value) {
    if (!value || value === 'none') return [];
    var out = [];
    var parts = splitTop(value);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === 'none') continue;
      var m = /^(repeating-)?(linear|radial)-gradient\\((.*)\\)$/.exec(parts[i]);
      if (!m || m[1]) return null;
      out.push({ type: m[2], args: splitTop(m[3]) });
    }
    return out;
  }
  // Colour stops as [{pos (0..1), c}], positions filled in the CSS way.
  function stops(args, length) {
    var list = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      var m = /^(rgba?\\([^)]*\\)|[a-z]+\\([^)]*\\)|#[0-9a-f]+|[a-z]+)\\s*(.*)$/i.exec(a);
      if (!m) continue;
      var c = rgba(m[1]);
      if (!c) continue;
      var poss = m[2].trim() ? m[2].trim().split(/\\s+/) : [];
      var conv = function (p) {
        if (/%$/.test(p)) return parseFloat(p) / 100;
        if (/px$/.test(p)) return length > 0 ? parseFloat(p) / length : 0;
        return null;
      };
      if (poss.length === 0) list.push({ pos: null, c: c });
      for (var k = 0; k < poss.length; k++) list.push({ pos: conv(poss[k]), c: c });
    }
    if (list.length === 0) return list;
    if (list[0].pos == null) list[0].pos = 0;
    if (list[list.length - 1].pos == null) list[list.length - 1].pos = 1;
    var last = 0;
    for (var j = 0; j < list.length; j++) {
      if (list[j].pos == null) {
        var n = j; while (list[n].pos == null) n++;
        for (var q = j; q < n; q++) list[q].pos = last + (list[n].pos - last) * (q - j + 1) / (n - j + 1);
      }
      list[j].pos = Math.max(last, list[j].pos);
      last = list[j].pos;
    }
    // CSS fades in premultiplied colour: a transparent stop takes its
    // neighbour's colour, so no grey band shows in the picture.
    for (var t = 0; t < list.length; t++) {
      if (list[t].c[3] === 0) {
        var nb = list[t + 1] && list[t + 1].c[3] > 0 ? list[t + 1] : list[t - 1];
        if (nb) list[t].c = [nb.c[0], nb.c[1], nb.c[2], 0];
      }
    }
    return list;
  }
  function linearAngle(args) {
    var a = args[0];
    var m = /^(-?[\\d.]+)(deg|rad|turn|grad)$/.exec(a);
    if (m) {
      var v = parseFloat(m[1]);
      return { angle: m[2] === 'rad' ? v * 180 / Math.PI : m[2] === 'turn' ? v * 360 : m[2] === 'grad' ? v * 0.9 : v, rest: args.slice(1) };
    }
    if (/^to /.test(a)) {
      var map = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45,
        'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 };
      return { angle: map[a] != null ? map[a] : 180, rest: args.slice(1) };
    }
    return { angle: 180, rest: args };
  }
  function linearLength(angle, w, h) {
    var r = angle * Math.PI / 180;
    return Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r));
  }
  function svgStops(list, opacity) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      s += '<stop offset="' + list[i].pos.toFixed(4) + '" stop-color="rgb(' + Math.round(list[i].c[0]) + ',' + Math.round(list[i].c[1]) + ',' +
        Math.round(list[i].c[2]) + ')" stop-opacity="' + (list[i].c[3] * opacity).toFixed(4) + '"/>';
    }
    return s;
  }
  function lengthOf(v, total) {
    if (/%$/.test(v)) return parseFloat(v) / 100 * total;
    if (/px$/.test(v)) return parseFloat(v);
    var k = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }[v];
    return k != null ? k * total : total / 2;
  }
  // One gradient layer as an svg paint server over a w x h box.
  function gradientDef(layer, id, w, h, opacity) {
    if (layer.type === 'linear') {
      var la = linearAngle(layer.args);
      var len = linearLength(la.angle, w, h);
      var r = la.angle * Math.PI / 180;
      var dx = Math.sin(r) * len / 2, dy = -Math.cos(r) * len / 2;
      return '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + (w / 2 - dx) + '" y1="' + (h / 2 - dy) +
        '" x2="' + (w / 2 + dx) + '" y2="' + (h / 2 + dy) + '">' + svgStops(stops(la.rest, len), opacity) + '</linearGradient>';
    }
    // radial: [shape/size] [at position], stops...
    var args = layer.args, head = '', rest = args;
    if (args.length && !rgba(args[0].split(/\\s+/)[0]) && !/^#/.test(args[0])) { head = args[0]; rest = args.slice(1); }
    var at = head.split(' at ');
    var size = (at[0] || '').trim(), pos = (at[1] || 'center').trim().split(/\\s+/);
    var cx = lengthOf(pos[0] || 'center', w), cy = lengthOf(pos[1] || 'center', h);
    if (pos.length === 1 && (pos[0] === 'top' || pos[0] === 'bottom')) { cx = w / 2; cy = lengthOf(pos[0], h); }
    var dxs = Math.max(cx, w - cx), dys = Math.max(cy, h - cy);
    var rx, ry;
    var px = size.split(/\\s+/).filter(function (s) { return /px$|%$/.test(s); });
    if (px.length >= 2) { rx = lengthOf(px[0], w); ry = lengthOf(px[1], h); }
    else if (px.length === 1) { rx = ry = lengthOf(px[0], w); }
    else if (/closest-side/.test(size)) { rx = Math.min(cx, w - cx); ry = Math.min(cy, h - cy); }
    else if (/farthest-side/.test(size)) { rx = dxs; ry = dys; }
    else if (/closest-corner/.test(size)) { rx = Math.min(cx, w - cx) * Math.SQRT2; ry = Math.min(cy, h - cy) * Math.SQRT2; }
    else { rx = dxs * Math.SQRT2; ry = dys * Math.SQRT2; }
    if (/circle/.test(size) && px.length < 2) { rx = ry = /closest/.test(size) ? Math.min(rx, ry) : Math.max(rx, ry); }
    rx = Math.max(rx, 0.5); ry = Math.max(ry, 0.5);
    return '<radialGradient id="' + id + '" gradientUnits="userSpaceOnUse" cx="' + cx + '" cy="' + cy + '" r="' + rx +
      '" gradientTransform="translate(' + cx + ' ' + cy + ') scale(1 ' + (ry / rx) + ') translate(' + (-cx) + ' ' + (-cy) + ')">' +
      svgStops(stops(rest, rx), opacity) + '</radialGradient>';
  }

  // --- Geometry ---

  var origin = null, scale = 1;
  function box(r) {
    return { x: (r.left - origin.left) / scale, y: (r.top - origin.top) / scale, w: r.width / scale, h: r.height / scale };
  }
  function px(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round(n) { return Math.round(n * 100) / 100; }

  // --- Pseudo-elements ---

  // A real element standing in for each drawn ::before / ::after, with the
  // pseudo's computed style; the pseudo is hidden meanwhile.
  var HIDE_CLASS = 'conduit-scene-nopseudo';
  function standIns(root) {
    var made = [];
    var style = document.createElement('style');
    style.textContent = '.' + HIDE_CLASS + '-before::before{content:none!important}.' + HIDE_CLASS + '-after::after{content:none!important}';
    document.head.appendChild(style);
    var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    var plans = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.namespaceURI === SVG_NS) continue;
      for (var k = 0; k < 2; k++) {
        var which = k === 0 ? '::before' : '::after';
        var cs = getComputedStyle(el, which);
        var content = cs.content;
        if (!content || content === 'none' || content === 'normal' || cs.display === 'none') continue;
        var text = '';
        var m = /^"((?:[^"\\\\]|\\\\.)*)"$/.exec(content);
        if (m) text = m[1].replace(/\\\\(.)/g, '$1');
        else if (content !== '""' && !/^counter/.test(content)) continue;
        var copy = {};
        for (var p = 0; p < cs.length; p++) copy[cs[p]] = cs.getPropertyValue(cs[p]);
        plans.push({ el: el, before: k === 0, text: text, style: copy });
      }
    }
    for (var j = 0; j < plans.length; j++) {
      var plan = plans[j];
      var stand = document.createElement('span');
      stand.setAttribute('data-scene-pseudo', '');
      for (var prop in plan.style) {
        if (prop === 'content') continue;
        stand.style.setProperty(prop, plan.style[prop]);
      }
      stand.textContent = plan.text;
      plan.el.classList.add(HIDE_CLASS + (plan.before ? '-before' : '-after'));
      if (plan.before) plan.el.insertBefore(stand, plan.el.firstChild);
      else plan.el.appendChild(stand);
      made.push({ el: plan.el, stand: stand, cls: HIDE_CLASS + (plan.before ? '-before' : '-after') });
    }
    return function restore() {
      for (var i = 0; i < made.length; i++) {
        if (made[i].stand.parentNode) made[i].stand.parentNode.removeChild(made[i].stand);
        made[i].el.classList.remove(made[i].cls);
      }
      style.remove();
    };
  }

  // --- Drawings ---

  function inlineSvg(src) {
    var clone = src.cloneNode(true);
    var a = [src].concat(Array.prototype.slice.call(src.querySelectorAll('*')));
    var b = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
    for (var i = 0; i < a.length && i < b.length; i++) {
      var cs = getComputedStyle(a[i]);
      var decl = '';
      for (var p = 0; p < SVG_PROPS.length; p++) {
        var v = cs.getPropertyValue(SVG_PROPS[p]);
        if (v) decl += SVG_PROPS[p] + ':' + v + ';';
      }
      b[i].setAttribute('style', decl);
      b[i].removeAttribute('class');
    }
    var r = src.getBoundingClientRect();
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('width', String(round(r.width / scale)));
    clone.setAttribute('height', String(round(r.height / scale)));
    var color = rgba(getComputedStyle(src).color);
    if (color) clone.style.setProperty('color', cssColor(color));
    return new XMLSerializer().serializeToString(clone);
  }

  // --- Boxes ---

  function sideOf(cs, side) {
    var w = px(cs.getPropertyValue('border-' + side + '-width'));
    var st = cs.getPropertyValue('border-' + side + '-style');
    var c = rgba(cs.getPropertyValue('border-' + side + '-color'));
    if (!w || st === 'none' || st === 'hidden' || !c || c[3] === 0) return null;
    return { w: w, style: st, c: c };
  }
  function same(a, b) {
    return a && b && a.w === b.w && a.style === b.style && a.c.join() === b.c.join();
  }

  // The decoration of one element: zero or more items.
  function decorate(el, cs, b, opacity, items) {
    var bgc = rgba(cs.backgroundColor);
    var lay = layers(cs.backgroundImage);
    var sides = { top: sideOf(cs, 'top'), right: sideOf(cs, 'right'), bottom: sideOf(cs, 'bottom'), left: sideOf(cs, 'left') };
    var hasBg = (bgc && bgc[3] > 0) || (lay && lay.length > 0);
    if (!hasBg && !sides.top && !sides.right && !sides.bottom && !sides.left) return;
    if (b.w < 0.5 || b.h < 0.5) return;
    var radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(function (v) {
      var n = /%$/.test(v) ? parseFloat(v) / 100 * Math.min(b.w, b.h) : px(v);
      return Math.min(n, Math.min(b.w, b.h) / 2);
    });
    var even = radii[0] === radii[1] && radii[1] === radii[2] && radii[2] === radii[3];
    var uniform = same(sides.top, sides.right) && same(sides.right, sides.bottom) && same(sides.bottom, sides.left);
    var simpleFill = !lay || lay.length === 0 || (lay.length === 1 && lay[0].type === 'linear' && !(bgc && bgc[3] > 0));
    if (lay === null || !simpleFill || !even) {
      // As a picture: background colour, gradient layers, then the border.
      var defs = '', body = '';
      var rr = even ? radii[0] : 0;
      var clipId = 'c', clip = '';
      if (!even) {
        clip = '<clipPath id="' + clipId + '"><path d="' + roundedPath(b.w, b.h, radii) + '"/></clipPath>';
      }
      var shapeAttr = even ? ' rx="' + rr + '" ry="' + rr + '"' : '';
      var clipAttr = even ? '' : ' clip-path="url(#' + clipId + ')"';
      if (bgc && bgc[3] > 0) body += '<rect width="' + b.w + '" height="' + b.h + '"' + shapeAttr + clipAttr + ' fill="' + cssColor(bgc, opacity) + '"/>';
      var list = lay || [];
      for (var i = list.length - 1; i >= 0; i--) {
        defs += gradientDef(list[i], 'g' + i, b.w, b.h, opacity);
        body += '<rect width="' + b.w + '" height="' + b.h + '"' + shapeAttr + clipAttr + ' fill="url(#g' + i + ')"/>';
      }
      if (uniform && sides.top) {
        var sw = sides.top.w;
        body += '<rect x="' + sw / 2 + '" y="' + sw / 2 + '" width="' + Math.max(0, b.w - sw) + '" height="' + Math.max(0, b.h - sw) + '"' +
          (even ? ' rx="' + Math.max(0, rr - sw / 2) + '"' : '') + ' fill="none" stroke="' + cssColor(sides.top.c, opacity) + '" stroke-width="' + sw + '"/>';
      }
      var svg = '<svg xmlns="' + SVG_NS + '" width="' + round(b.w) + '" height="' + round(b.h) + '" viewBox="0 0 ' + b.w + ' ' + b.h + '"><defs>' + clip + defs + '</defs>' + body + '</svg>';
      items.push({ kind: 'picture', x: b.x, y: b.y, w: b.w, h: b.h, svg: svg });
      if (!uniform) borderSides(b, sides, opacity, items);
      return;
    }
    var fill = null;
    if (lay && lay.length === 1) {
      var la = linearAngle(lay[0].args);
      fill = { type: 'linear', angle: la.angle, stops: stops(la.rest, linearLength(la.angle, b.w, b.h)).map(function (s) {
        return { pos: s.pos, color: hex(s.c, opacity) };
      }) };
    } else if (bgc && bgc[3] > 0) {
      fill = { type: 'solid', color: hex(bgc, opacity) };
    }
    var line = uniform && sides.top ? { width: sides.top.w, color: hex(sides.top.c, opacity), dash: sides.top.style === 'dashed' || sides.top.style === 'dotted' } : null;
    if (fill || line) {
      var item = { kind: 'shape', x: b.x, y: b.y, w: b.w, h: b.h, radius: radii[0], fill: fill, line: line };
      var sh = shadowOf(cs, opacity);
      if (sh) item.shadow = sh;
      items.push(item);
    }
    if (!uniform) borderSides(b, sides, opacity, items);
  }
  // The first outer box-shadow: {x, y, blur, color}.
  function shadowOf(cs, opacity) {
    var v = cs.boxShadow;
    if (!v || v === 'none') return null;
    var list = splitTop(v);
    for (var i = 0; i < list.length; i++) {
      if (/\\binset\\b/.test(list[i])) continue;
      var col = /(rgba?\\([^)]*\\)|#[0-9a-f]+)/i.exec(list[i]);
      var c = col ? rgba(col[0]) : rgba(cs.color);
      var nums = list[i].replace(col ? col[0] : '', '').trim().split(/\\s+/).map(px);
      if (!c || c[3] === 0 || nums.length < 2) continue;
      return { x: nums[0], y: nums[1], blur: nums[2] || 0, color: hex(c, opacity) };
    }
    return null;
  }
  function borderSides(b, s, opacity, items) {
    var add = function (x, y, w, h, side) {
      items.push({ kind: 'shape', x: x, y: y, w: w, h: h, radius: 0, fill: { type: 'solid', color: hex(side.c, opacity) }, line: null });
    };
    if (s.top) add(b.x, b.y, b.w, s.top.w, s.top);
    if (s.bottom) add(b.x, b.y + b.h - s.bottom.w, b.w, s.bottom.w, s.bottom);
    if (s.left) add(b.x, b.y, s.left.w, b.h, s.left);
    if (s.right) add(b.x + b.w - s.right.w, b.y, s.right.w, b.h, s.right);
  }
  function roundedPath(w, h, r) {
    return 'M' + r[0] + ',0H' + (w - r[1]) + 'A' + r[1] + ',' + r[1] + ' 0 0 1 ' + w + ',' + r[1] + 'V' + (h - r[2]) +
      'A' + r[2] + ',' + r[2] + ' 0 0 1 ' + (w - r[2]) + ',' + h + 'H' + r[3] + 'A' + r[3] + ',' + r[3] + ' 0 0 1 0,' + (h - r[3]) +
      'V' + r[0] + 'A' + r[0] + ',' + r[0] + ' 0 0 1 ' + r[0] + ',0Z';
  }

  // --- Text ---

  function isInline(cs) { return INLINE[cs.display] === 1; }

  function weightOf(cs) {
    var w = cs.fontWeight;
    if (w === 'bold') return 700;
    if (w === 'normal') return 400;
    var n = parseInt(w, 10);
    return isNaN(n) ? 400 : n;
  }

  function glowOf(cs, opacity) {
    var ts = cs.textShadow;
    if (!ts || ts === 'none') return null;
    var first = splitTop(ts)[0];
    var col = /(rgba?\\([^)]*\\)|#[0-9a-f]+)/i.exec(first);
    var nums = first.replace(col ? col[0] : '', '').trim().split(/\\s+/).map(px);
    var c = col ? rgba(col[0]) : rgba(cs.color);
    if (!c || nums.length < 2) return null;
    var blur = nums[2] || 0;
    if (blur <= 0) return null;
    return { radius: blur, color: hex(c, opacity) };
  }

  function runOf(text, cs, opacity) {
    var c = rgba(cs.color) || [0, 0, 0, 1];
    var deco = cs.textDecorationLine || cs.textDecoration || '';
    var ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing);
    var va = cs.verticalAlign;
    var tt = cs.textTransform;
    if (tt === 'lowercase') text = text.toLowerCase();
    else if (tt === 'capitalize') text = text.replace(/(^|\\s)(\\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
    var run = {
      text: text,
      font: cs.fontFamily,
      size: round(px(cs.fontSize)),
      weight: weightOf(cs),
      italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
      color: hex(c, opacity),
      underline: deco.indexOf('underline') >= 0,
      strike: deco.indexOf('line-through') >= 0,
      spacing: round(ls),
      caps: tt === 'uppercase',
      baseline: va === 'super' ? 30 : va === 'sub' ? -25 : 0
    };
    var g = glowOf(cs, opacity);
    if (g) run.glow = g;
    return run;
  }

  // Where the browser wrapped a block's lines: the text nodes and offsets of
  // the first character of every line after the first.
  function wrapPoints(block) {
    var points = [];
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var range = document.createRange();
    var lastTop = null;
    var n;
    while ((n = walker.nextNode())) {
      if (!inBlock(n, block)) continue;
      var s = n.data;
      for (var i = 0; i < s.length; i++) {
        if (/\\s/.test(s.charAt(i))) continue;
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        var rects = range.getClientRects();
        if (!rects.length) continue;
        var top = rects[0].top;
        var lh = rects[0].height;
        if (lastTop !== null && top > lastTop + lh * 0.5) points.push({ node: n, offset: i });
        lastTop = top;
        // Skip to the end of the word: a line can only break between words.
        while (i + 1 < s.length && !/\\s/.test(s.charAt(i + 1)) && !/[\\u2E80-\\uFFEF]/.test(s.charAt(i + 1))) i++;
      }
    }
    return points;
  }

  // Is text node n inside block directly or through inline elements only?
  function inBlock(n, block) {
    var p = n.parentNode;
    while (p && p !== block) {
      if (p.nodeType === 1 && (!isInline(getComputedStyle(p)) || p.namespaceURI === SVG_NS)) return false;
      p = p.parentNode;
    }
    return p === block;
  }

  // The runs of a block's own inline content (nested blocks are skipped:
  // they are their own text items).
  function blockRuns(block, opacity, breaks) {
    var runs = [];
    var bset = breaks || [];
    function emit(text, cs) {
      if (!text) return;
      var last = runs[runs.length - 1];
      var r = runOf(text, cs, opacity);
      if (last && last.font === r.font && last.size === r.size && last.weight === r.weight && last.italic === r.italic &&
          last.color === r.color && last.underline === r.underline && last.strike === r.strike && last.spacing === r.spacing &&
          last.caps === r.caps && last.baseline === r.baseline && JSON.stringify(last.glow) === JSON.stringify(r.glow)) {
        last.text += r.text;
      } else {
        runs.push(r);
      }
    }
    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var cs = getComputedStyle(node);
          var pre = /^pre/.test(cs.whiteSpace) || cs.whiteSpace === 'break-spaces';
          var text = c.data;
          // A wrap point becomes \\u0001, then a line break once spaces collapse.
          var cuts = [];
          for (var b = 0; b < bset.length; b++) if (bset[b].node === c) cuts.push(bset[b].offset);
          cuts.sort(function (x, y) { return y - x; });
          for (var k = 0; k < cuts.length; k++) text = text.slice(0, cuts[k]) + '\\u0001' + text.slice(cuts[k]);
          if (!pre) text = text.replace(/\\s+/g, ' ');
          // The space a line broke at is not drawn.
          text = text.replace(/ ?\\u0001 ?/g, '\\n');
          emit(text, cs);
        } else if (c.nodeType === 1) {
          var el = c;
          if (el.namespaceURI === SVG_NS) continue;
          var ecs = getComputedStyle(el);
          if (ecs.display === 'none') continue;
          if (el.tagName === 'BR') { emit('\\n', ecs); continue; }
          if (!isInline(ecs)) continue;
          walk(el);
        }
      }
    }
    walk(block);
    // Collapse spaces across runs and trim the paragraph.
    var prevSpace = true;
    for (var i = 0; i < runs.length; i++) {
      var t = runs[i].text;
      var out = '';
      for (var j = 0; j < t.length; j++) {
        var ch = t.charAt(j);
        if (ch === ' ') { if (!prevSpace) out += ch; prevSpace = true; }
        else if (ch === '\\n') { out = out.replace(/ $/, ''); out += ch; prevSpace = true; }
        else { out += ch; prevSpace = false; }
      }
      runs[i].text = out;
    }
    if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\\s+$/, '');
    return runs.filter(function (r) { return r.text !== ''; });
  }

  function hasOwnText(block) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (/\\S/.test(n.data) && inBlock(n, block)) return true;
    }
    return false;
  }

  function alignOf(cs) {
    var a = cs.textAlign;
    if (a === 'center' || a === '-webkit-center') return 'ctr';
    if (a === 'right' || (a === 'end' && cs.direction !== 'rtl') || (a === 'start' && cs.direction === 'rtl')) return 'r';
    if (a === 'justify') return 'just';
    return 'l';
  }

  function textItem(el, cs, b, opacity, isTitle) {
    var bl = px(cs.borderLeftWidth) + px(cs.paddingLeft), br = px(cs.borderRightWidth) + px(cs.paddingRight);
    var bt = px(cs.borderTopWidth) + px(cs.paddingTop), bb = px(cs.borderBottomWidth) + px(cs.paddingBottom);
    var wrapStyle = cs.textWrapStyle || cs.textWrap || '';
    var breaks = /balance|pretty/.test(wrapStyle) ? wrapPoints(el) : null;
    var runs = blockRuns(el, opacity, breaks);
    if (!runs.length) return null;
    var size = px(cs.fontSize);
    var lh = cs.lineHeight === 'normal' ? size * 1.2 : px(cs.lineHeight);
    // The text's own extent: a block can be wider than its text (a grid
    // cell), and the text box should hug what is drawn.
    return {
      kind: 'text',
      x: b.x + bl, y: b.y + bt, w: Math.max(1, b.w - bl - br), h: Math.max(1, b.h - bt - bb),
      title: isTitle,
      paras: [{ align: alignOf(cs), lineHeight: round(lh), runs: runs }]
    };
  }

  // --- The walk ---

  function capture(slide) {
    var saved = slide.getAttribute('style');
    slide.style.setProperty('visibility', 'visible', 'important');
    var restore = standIns(slide);
    try {
      origin = slide.getBoundingClientRect();
      scale = origin.width / W || 1;
      var items = [];
      var charts = 0;
      var titled = false;
      var scs = getComputedStyle(slide);
      var bgc = rgba(scs.backgroundColor) || [255, 255, 255, 1];
      var bgLayers = layers(scs.backgroundImage);
      var bgSvg = null;
      if (bgLayers && bgLayers.length) {
        var defs = '', body = '<rect width="' + W + '" height="' + H + '" fill="' + cssColor(bgc) + '"/>';
        for (var i = bgLayers.length - 1; i >= 0; i--) {
          defs += gradientDef(bgLayers[i], 'g' + i, W, H, 1);
          body += '<rect width="' + W + '" height="' + H + '" fill="url(#g' + i + ')"/>';
        }
        bgSvg = '<svg xmlns="' + SVG_NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><defs>' + defs + '</defs>' + body + '</svg>';
      }
      var visit = function (el, opacity) {
        if (items.length > MAX_ITEMS) return;
        var cs = getComputedStyle(el);
        if (cs.display === 'none') return;
        var op = opacity * px(cs.opacity === '' ? 1 : cs.opacity);
        if (op <= 0.001) return;
        var tag = el.tagName.toLowerCase();
        if (el.namespaceURI === SVG_NS) {
          if (tag !== 'svg') return;
          var r = box(el.getBoundingClientRect());
          if (r.w < 1 || r.h < 1) return;
          if (el.hasAttribute('data-chart')) {
            items.push({ kind: 'chart', x: r.x, y: r.y, w: r.w, h: r.h, index: charts });
            charts++;
            return;
          }
          var svg = inlineSvg(el);
          if (svg.length <= MAX_SVG) items.push({ kind: 'picture', x: r.x, y: r.y, w: r.w, h: r.h, svg: svg });
          return;
        }
        var b = box(el.getBoundingClientRect());
        if (el !== slide) {
          if (isInline(cs)) {
            var rects = el.getClientRects();
            for (var q = 0; q < rects.length; q++) decorate(el, cs, box(rects[q]), op, items);
          } else {
            decorate(el, cs, b, op, items);
          }
        }
        if (!isInline(cs) && hasOwnText(el)) {
          var isTitle = !titled && (el.classList.contains('headline') || /^h[12]$/.test(tag));
          var t = textItem(el, cs, b, op, isTitle);
          if (t) { items.push(t); titled = titled || isTitle; }
        }
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) visit(c, op);
      };
      visit(slide, 1);
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        it.x = round(it.x); it.y = round(it.y); it.w = round(it.w); it.h = round(it.h);
        if (it.kind === 'shape') it.radius = round(it.radius);
      }
      return { bg: hex(bgc), bgSvg: bgSvg, items: items };
    } finally {
      restore();
      if (saved === null) slide.removeAttribute('style'); else slide.setAttribute('style', saved);
    }
  }

  return { capture: capture, rgba: rgba, stops: stops, layers: layers };
})();
`;
