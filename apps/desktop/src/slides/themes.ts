/// Starter themes for decks, and the vocabulary the model may use.
///
/// A theme is one stylesheet scoped to `.deck` / `.slide`. It is frame
/// content, not app CSS: it runs inside the sandboxed deck frame, which has a
/// strict CSP, so there are no external fonts, only system stacks. The canvas
/// is 1920×1080; the frame scales it to fit.
///
/// Both starters are built from one structural sheet (`structure`) so every
/// layout and component in THEME_CONTRACT is styled by construction; each
/// theme then adds its own palette and flourishes.

export interface StarterTheme {
  name: string;
  label: string;
  css: string;
  dark: boolean;
}

interface Palette {
  bg: string;
  ink: string;
  ink2: string;
  accent: string;
  surface: string;
  fontDisplay: string;
  fontBody: string;
  fontMono: string;
}

/** Layouts and components shared by every theme; palette comes from tokens. */
function structure(p: Palette): string {
  return `
.deck, .slide {
  --bg: ${p.bg};
  --ink: ${p.ink};
  --ink-2: ${p.ink2};
  --accent: ${p.accent};
  --surface: ${p.surface};
  --font-display: ${p.fontDisplay};
  --font-body: ${p.fontBody};
  --font-mono: ${p.fontMono};
}
.slide {
  position: relative;
  box-sizing: border-box;
  width: 1920px;
  height: 1080px;
  padding: 120px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* safe: content that does not fit runs off the bottom, never the top. */
  justify-content: safe center;
  gap: 36px;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 40px;
  line-height: 1.42;
  -webkit-font-smoothing: antialiased;
}
.slide *, .slide *::before, .slide *::after { box-sizing: border-box; }
.slide :where(h1, h2, h3, p, ul, ol, figure, blockquote) { margin: 0; padding: 0; }
.slide svg, .slide img { display: block; max-width: 100%; max-height: 100%; }
/* A drawing at its own aspect ratio, inside a box the theme owns. */
.slide > svg, .slide > figure > svg { width: 100%; height: auto; max-height: 600px; flex: 0 0 auto; }

/* Components */
.slide .kicker {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
}
.slide .headline {
  font-family: var(--font-display);
  font-size: 104px;
  line-height: 1.04;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
  text-wrap: balance;
}
.slide .sub {
  font-size: 48px;
  line-height: 1.3;
  color: var(--ink-2);
  max-width: 1280px;
  text-wrap: pretty;
}
.slide .body {
  font-size: 40px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: 1400px;
  text-wrap: pretty;
}
.slide .accent { color: var(--accent); }
.slide strong, .slide b { font-weight: 700; color: var(--ink); }
.slide ul.bullets {
  list-style: none;
  display: grid;
  gap: 28px;
  font-size: 44px;
  line-height: 1.3;
  color: var(--ink);
  max-width: 1500px;
}
.slide ul.bullets > li {
  position: relative;
  padding-left: 56px;
}
.slide ul.bullets > li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.5em;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--accent);
}
.slide .stat {
  display: grid;
  /* The value cannot widen its column, so a value too wide shows as overflow. */
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-content: start;
  min-width: 0;
}
.slide .stat b {
  display: block;
  font-family: var(--font-display);
  font-size: 168px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--accent);
}
.slide .stat > span {
  display: block;
  font-size: 36px;
  line-height: 1.3;
  color: var(--ink-2);
  max-width: 460px;
}
.slide .quote {
  font-family: var(--font-display);
  font-size: 76px;
  line-height: 1.18;
  font-weight: 500;
  color: var(--ink);
  max-width: 1500px;
  text-wrap: balance;
}
.slide .cite {
  font-family: var(--font-mono);
  font-size: 30px;
  letter-spacing: 0.06em;
  color: var(--ink-2);
}
.slide .cite::before { content: "\\2014\\00a0"; color: var(--accent); }
.slide .col {
  display: grid;
  gap: 28px;
  align-content: start;
  min-width: 0;
  padding: 44px 48px;
  border-radius: 24px;
  background: var(--surface);
}
.slide .footnote {
  position: absolute;
  left: 120px;
  right: 120px;
  bottom: 56px;
  font-family: var(--font-mono);
  font-size: 24px;
  letter-spacing: 0.04em;
  color: var(--ink-2);
  opacity: 0.8;
}

/* Layouts */
.slide[data-layout="title"] { justify-content: safe flex-end; padding-bottom: 160px; gap: 40px; }
.slide[data-layout="title"] .headline { font-size: 132px; max-width: 1500px; }
.slide[data-layout="title"] .sub { max-width: 1200px; }
.slide[data-layout="title"]::before {
  content: "";
  position: absolute;
  left: 120px;
  top: 120px;
  width: 120px;
  height: 12px;
  border-radius: 6px;
  background: var(--accent);
}

.slide[data-layout="statement"] { justify-content: safe center; }
.slide[data-layout="statement"] .headline { font-size: 120px; max-width: 1600px; }

.slide[data-layout="bullets"] { justify-content: flex-start; padding-top: 140px; gap: 32px; }
.slide[data-layout="bullets"] .headline { font-size: 80px; margin-bottom: 24px; }

.slide[data-layout="stat-row"] { justify-content: safe center; gap: 48px; }
.slide[data-layout="stat-row"] .headline { font-size: 80px; }
.slide[data-layout="stat-row"] .stats,
.slide[data-layout="stat-row"] .row {
  display: flex;
  gap: 96px;
  align-items: flex-start;
}
.slide[data-layout="stat-row"]:not(:has(.stats, .row)) { flex-flow: row wrap; align-content: safe center; column-gap: 112px; row-gap: 56px; }
.slide[data-layout="stat-row"]:not(:has(.stats, .row)) > :not(.stat) { flex: 0 0 100%; }
.slide[data-layout="stat-row"] .stat { flex: 1 1 0; }

.slide[data-layout="two-col"] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-auto-rows: min-content;
  align-content: safe center;
  column-gap: 64px;
  row-gap: 40px;
}
.slide[data-layout="two-col"] > :not(.col) { grid-column: 1 / -1; }
.slide[data-layout="two-col"] .headline { font-size: 80px; }

.slide[data-layout="quote"] { justify-content: safe center; gap: 48px; padding-left: 200px; }
.slide[data-layout="quote"]::before {
  content: "\\201C";
  position: absolute;
  left: 100px;
  top: 90px;
  font-family: var(--font-display);
  font-size: 360px;
  line-height: 1;
  color: var(--accent);
  opacity: 0.9;
}

.slide[data-layout="section"] { justify-content: safe flex-end; padding-bottom: 180px; gap: 28px; }
.slide[data-layout="section"] .headline { font-size: 136px; max-width: 1500px; }
.slide[data-layout="section"] .kicker { font-size: 40px; }
.slide[data-layout="section"]::after {
  content: "";
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 36px;
  background: var(--accent);
}

/* The text column flows normally, padded clear of the visual column; the
   visual sits in that column at its own aspect ratio, so it can neither
   stretch a grid (implicit rows and their gaps add phantom height) nor push
   the headline off the slide. The theme owns the visual's box. */
.slide[data-layout="image-left"] { justify-content: safe center; gap: 28px; padding-left: 1036px; }
.slide[data-layout="image-left"] > svg,
.slide[data-layout="image-left"] > img,
.slide[data-layout="image-left"] > figure,
.slide[data-layout="image-left"] > .image {
  position: absolute;
  left: 120px;
  top: 50%;
  transform: translateY(-50%);
  width: 820px !important;
  height: auto !important;
  max-height: 840px !important;
  object-fit: contain;
  border-radius: 24px;
  background: var(--surface);
}
.slide[data-layout="image-left"] > figure > svg { max-height: 840px; }
.slide[data-layout="image-left"] .headline { font-size: 80px; }

/* One chart or diagram, full width, under a headline. */
.slide[data-layout="chart"] { justify-content: safe center; gap: 40px; }
.slide[data-layout="chart"] .headline { font-size: 80px; }
.slide[data-layout="chart"] > svg,
.slide[data-layout="chart"] > figure {
  width: 1680px !important;
  height: auto !important;
  max-height: 640px !important;
  flex: 0 0 auto;
}
.slide[data-layout="chart"] > figure > svg { max-height: 640px; }
`;
}

const INK = structure({
  bg: '#0c0d12',
  ink: '#f4f1ec',
  ink2: '#a9a7b3',
  accent: '#ff7a59',
  surface: '#171923',
  fontDisplay: '"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontBody: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontMono: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace',
});

const INK_FLOURISH = `
.slide {
  background:
    radial-gradient(1100px 700px at 100% 0%, rgba(255, 122, 89, 0.16), transparent 60%),
    radial-gradient(900px 600px at 0% 100%, rgba(255, 122, 89, 0.06), transparent 60%),
    var(--bg);
}
.slide .headline { font-weight: 650; }
.slide .col {
  background: linear-gradient(160deg, #1b1e2a, #14161f);
  border: 2px solid #262a38;
}
.slide .col .kicker { font-size: 24px; }
.slide .stat b { text-shadow: 0 0 80px rgba(255, 122, 89, 0.35); }
.slide[data-layout="stat-row"] .stat {
  padding-top: 36px;
  border-top: 3px solid #2a2e3d;
}
.slide[data-layout="section"] {
  background:
    radial-gradient(1400px 900px at 100% 100%, rgba(255, 122, 89, 0.22), transparent 60%),
    var(--bg);
}
`;

const PAPER = structure({
  bg: '#f7f4ec',
  ink: '#1b1c2b',
  ink2: '#585a6e',
  accent: '#4b4ded',
  surface: '#ffffff',
  fontDisplay: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
  fontBody: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontMono: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace',
});

const PAPER_FLOURISH = `
.slide .headline { font-weight: 600; letter-spacing: -0.015em; }
.slide .kicker { font-size: 26px; letter-spacing: 0.2em; }
.slide .stat b { font-weight: 600; }
.slide .col {
  background: #ffffff;
  border: 2px solid #e6e1d3;
  box-shadow: 0 24px 60px -32px rgba(40, 40, 90, 0.28);
}
.slide ul.bullets > li::before { border-radius: 50%; width: 18px; height: 18px; }
.slide[data-layout="stat-row"] .stat {
  padding-top: 32px;
  border-top: 4px solid #1b1c2b;
}
.slide[data-layout="bullets"] .headline,
.slide[data-layout="two-col"] .headline,
.slide[data-layout="stat-row"] .headline,
.slide[data-layout="image-left"] .headline {
  padding-bottom: 32px;
  border-bottom: 2px solid #ddd8c8;
}
.slide[data-layout="title"] { background: #f1ede1; }
.slide[data-layout="title"]::before { width: 200px; height: 6px; border-radius: 0; }
.slide[data-layout="quote"] .quote { font-style: italic; font-weight: 400; }
.slide[data-layout="section"] { background: #1b1c2b; color: #f7f4ec; }
.slide[data-layout="section"] .headline { color: #f7f4ec; }
.slide[data-layout="section"] .kicker { color: #aeb0ff; }
.slide[data-layout="section"]::after { background: var(--accent); }
`;

export const STARTER_THEMES: StarterTheme[] = [
  { name: 'ink', label: 'Ink', css: INK + INK_FLOURISH, dark: true },
  { name: 'paper', label: 'Paper', css: PAPER + PAPER_FLOURISH, dark: false },
];

/**
 * The vocabulary the model may use, sent in the prompt: the typed layouts with
 * their fields and limits (the slide tools validate the same limits), the
 * chart and svg fields, and for `custom` slides the classes and tokens every
 * theme styles.
 */
export const THEME_CONTRACT = `Slide canvas: 1920 x 1080 pixels, read from across a room. Pick the layout that fits each slide's point and pass its fields; the theme styles them. Text fields are plain text plus the inline tags span, em, strong, b, i, u, br, sub, sup, small and mark, with class as the only attribute (<span class="accent">word</span> sets a word in the accent color). Limits count visible words.

Layouts (the layout argument) and their fields:
- title: headline (≤ 10 words), sub (≤ 20), optional kicker (≤ 4).
- statement: one big headline (≤ 14 words), optional sub (≤ 20).
- bullets: headline (≤ 10 words), bullets: 2-5 items of ≤ 14 words; optional kicker.
- stat-row: stats: 2-4 {value, label}; value ≤ 6 characters, the number only ("42%", "3.1×", "$12M"); label ≤ 8 words, units and context go here. Optional headline (≤ 10 words), kicker, footnote.
- two-col: headline (≤ 10 words), columns: exactly 2 {kicker (≤ 4 words), then body (≤ 30 words) or bullets (2-4 items of ≤ 10 words)}; optional kicker.
- quote: quote (≤ 30 words), cite (≤ 8 words).
- section: headline (≤ 8 words), optional kicker (≤ 4, for example "Part 2").
- image-left: headline (≤ 10 words), body (≤ 30 words) or bullets (2-3 items of ≤ 12 words), and exactly one of chart or svg, drawn in an 820 x 600 box on the left.
- chart: headline (≤ 12 words) and exactly one of chart or svg, drawn full width (1680 x up to 640); optional kicker, footnote.
- custom: html only (below).
footnote, a source or note of ≤ 20 words, fits every layout except title, section and custom. kicker, ≤ 4 words everywhere, is a small uppercase label above the headline.

chart is data; the app draws it in the theme:
- bar: {"type": "bar", "categories": ["Q1", "Q2", "Q3", "Q4"], "series": [{"name": "Revenue", "values": [1.2, 1.8, 2.1, 2.9]}], "unit_prefix": "$", "unit_suffix": "M", "highlight": [3]}. Up to 12 categories and 1-3 series; highlight lists category indexes to draw in the accent color; optional y_label.
- line: the same shape without highlight, up to 24 categories and 1-4 series.
- funnel: {"type": "funnel", "stages": [{"label": "Visited", "value": 12000}, {"label": "Signed up", "value": 2400}, {"label": "Paid", "value": 310}]}. 2-7 stages.
Each values list has one number per category. Values are plain numbers; units go in unit_prefix and unit_suffix. Labels ≤ 4 words.

svg, for a diagram no chart type can show: exactly one <svg> element with a viewBox shaped like its box (about 1680 x 640 in chart, 820 x 600 in image-left). The app sizes it: no width, height or style on it. Text scales with the drawing, so with such a viewBox use font-size 24 or more (text that would render below 20px is rejected). Colors and fonts from the theme tokens: var(--ink), var(--ink-2), var(--accent), var(--surface), var(--font-body). No scripts, event handlers or external links.

custom: html, the slide's inner HTML, only when no layout fits; custom slides get a layout check after your turn. No <section> wrapper. Put every piece of visible text in an element with a data-text attribute naming its slot (data-text="headline", data-text="point-1"). Use the theme classes: .kicker, .headline, .sub, .body, ul.bullets, .stat (<b> value, <span> label), .col (a card), .quote, .cite, .footnote, .accent. Colors and fonts only as var(--name) of the tokens --bg, --ink, --ink-2, --accent, --surface, --font-display, --font-body, --font-mono; never hard-coded. No scripts and no external URLs; images are inline SVG or data: URIs.`;
