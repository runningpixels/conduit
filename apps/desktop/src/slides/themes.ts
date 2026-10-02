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
  justify-content: center;
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
.slide .stat span {
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
.slide[data-layout="title"] { justify-content: flex-end; padding-bottom: 160px; gap: 40px; }
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

.slide[data-layout="statement"] { justify-content: center; }
.slide[data-layout="statement"] .headline { font-size: 120px; max-width: 1600px; }

.slide[data-layout="bullets"] { justify-content: flex-start; padding-top: 140px; gap: 32px; }
.slide[data-layout="bullets"] .headline { font-size: 80px; margin-bottom: 24px; }

.slide[data-layout="stat-row"] { justify-content: center; gap: 48px; }
.slide[data-layout="stat-row"] .headline { font-size: 80px; }
.slide[data-layout="stat-row"] .stats,
.slide[data-layout="stat-row"] .row {
  display: flex;
  gap: 96px;
  align-items: flex-start;
}
.slide[data-layout="stat-row"]:not(:has(.stats, .row)) { flex-flow: row wrap; align-content: center; column-gap: 112px; row-gap: 56px; }
.slide[data-layout="stat-row"]:not(:has(.stats, .row)) > :not(.stat) { flex: 0 0 100%; }
.slide[data-layout="stat-row"] .stat { flex: 1 1 0; }

.slide[data-layout="two-col"] {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: min-content;
  align-content: center;
  column-gap: 64px;
  row-gap: 40px;
}
.slide[data-layout="two-col"] > :not(.col) { grid-column: 1 / -1; }
.slide[data-layout="two-col"] .headline { font-size: 80px; }

.slide[data-layout="quote"] { justify-content: center; gap: 48px; padding-left: 200px; }
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

.slide[data-layout="section"] { justify-content: flex-end; padding-bottom: 180px; gap: 28px; }
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

.slide[data-layout="image-left"] {
  display: grid;
  grid-template-columns: 820px 1fr;
  grid-auto-rows: min-content;
  align-content: center;
  column-gap: 96px;
  row-gap: 28px;
}
.slide[data-layout="image-left"] > svg,
.slide[data-layout="image-left"] > img,
.slide[data-layout="image-left"] > figure,
.slide[data-layout="image-left"] > .image {
  grid-column: 1;
  grid-row: 1 / span 12;
  align-self: stretch;
  justify-self: stretch;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 24px;
  background: var(--surface);
}
.slide[data-layout="image-left"] > :not(svg):not(img):not(figure):not(.image) { grid-column: 2; }
.slide[data-layout="image-left"] .headline { font-size: 80px; }
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

/** The vocabulary a theme styles and the model may use. Sent in the prompt. */
export const THEME_CONTRACT = `Slide canvas: 1920 x 1080 pixels. Each slide is one <section class="slide" data-layout="..."> and you write only its inner HTML. Style with the theme; never hard-code colors or fonts.

Layouts (set with the layout argument; the section's data-layout):
- title: .kicker (optional), .headline, .sub.
- statement: one big .headline, optionally .sub.
- bullets: .headline and ul.bullets with 3 to 5 short <li>.
- stat-row: .headline (optional) and 2 to 4 .stat blocks, each <div class="stat"><b>42%</b><span>what it measures</span></div>.
- two-col: .headline and two .col blocks, each with a .kicker and .body or ul.bullets.
- quote: .quote, then .cite for the source.
- section: .kicker (for example "Part 2") and a .headline.
- image-left: an inline <svg> or <img src="data:..."> first, then .headline and .body or ul.bullets.

Components:
- .kicker: small uppercase label above a headline.
- .headline: the slide's main line.
- .sub: one supporting line under a headline.
- .body: a short paragraph.
- ul.bullets: bulleted list.
- .stat with <b> (the number) and <span> (its label).
- .quote and .cite.
- .col: a card used in two-col.
- .footnote: a small source or note at the bottom.
- .accent: inline emphasis in the accent color, for example <span class="accent">word</span>.

Theme tokens (CSS custom properties; use var(--name) in any inline SVG or style):
--bg, --ink, --ink-2, --accent, --surface, --font-display, --font-body, --font-mono.

Rules: no <script>, no external URLs or fonts; images and charts are inline SVG or data: URIs. Keep text short: headlines under 12 words, no more than 5 bullets.`;
