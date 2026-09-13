# Theming — decision log

Running record of the calls made while building design themes
(branch `feat/theming`). The working plan is `docs/private/theming-plan.md`
(gitignored); this file is the committed, authoritative record of what was
actually decided and why. Newest phase last.

## Standing decisions (made before Phase 0)

| # | Decision | Why |
|---|---|---|
| S1 | First terminal theme is named **Amber Terminal**, not "OpenTerminal". | The look is inspired by github.com/ErTasselli/OpenTerminal (MIT). Using its name would imply affiliation. Credited in `THIRD-PARTY-NOTICES` and in the theme manifest (`inspiredBy`). |
| S2 | Terminal look uses the **bundled Geist Mono**, not a new font or the system mono stack. | Keeps CSP `font-src 'self'`, offline launch and identical metrics across OSes (same reasoning as tokens.css D3). No new font licence. |
| S3 | Amber Terminal renders assistant prose in mono by default; Appearance gets a **Reading font** override (theme / sans / serif). | Mono prose is the look; long answers in mono are tiring for some, so the escape hatch ships with it. |
| S4 | Amber Terminal is **dark-only**; a light companion ("Amber Paper") comes in Phase 4. | The source look is dark-only; a theme declares its supported modes and the mode control is disabled for dark-only themes without mutating `AppSettings.theme`. |
| S5 | Users pick a **Theme**; an **Advanced** disclosure exposes Look × Palette mixing. | The axes are orthogonal by construction, so mixing costs nothing and makes every palette N themes. |
| S6 | An active **brand locks the palette**; the look stays user-selectable. | Brands own colour identity; structure is a reading preference. |
| S7 | Phase 5 (user theme files) is **in scope**, using the brand pipeline's validation model: hex colours + enum-only structure, never raw CSS or URLs. | Same security guarantees as `brand.md`; no new attack surface class. |

## Phase 0 — baseline

| # | Decision | Why |
|---|---|---|
| P0.1 | Visual snapshots are **local-only** (`pnpm test:visual`, snapshots gitignored), not a CI gate. | Font rasterisation differs across OSes; committed PNG baselines would flap. CI keeps the text-parsing guards. |
| P0.2 | A DEV-only `?route=gallery` renders every surface with fixtures; it is the screenshot target and the design workbench for new themes. | `dev:web` has no backend, so most surfaces are otherwise empty. |

## Phase 1 — structural tokens

| # | Decision | Why |
|---|---|---|
| P1.1 | **No `:where()` / `@layer` rewrite** of existing axis selectors (deviation from the plan). Instead the axes are kept orthogonal by contract: look blocks may only declare structural tokens, palette blocks only colour tokens (test-enforced). | The provider-colour-off and brand-inherit rules in tokens.css depend on today's specificity with long, verified reasoning. Rewriting them for a hazard that orthogonality already prevents is risk without benefit. |
| P1.2 | Look selectors are `html[data-look="…"]` (0,1,1) so they beat `:root` (0,1,0) regardless of source order. | Role tokens may be declared in `:root` blocks of individual stylesheets; looks must win over all of them. |
| P1.3 | Literal sizes map to the **existing scale when the value matches exactly**; off-scale values become named role tokens (never rounded). New primitive steps: `--fs-3xs` 9px, `--fs-2xs` 9.5px, `--r-1..4`, `--r-round`. | Rounding would break the zero-visual-change contract. |
| P1.4 | Inline TSX styles may reference tokens (`fontSize: 'var(--fs-xl)'`) instead of being moved to classes. | A look retargets the variable either way; moving ~180 declarations to classes is churn with no theming benefit. |
| P1.6 | Off-scale **role tokens live in a `:root` block at the top of the stylesheet that owns them** (chat.css, settings.css, workspace.css, document-panel.css), not in tokens.css. | Keeps each role next to its only consumer; looks override them from `html[data-look]`, which outranks `:root` wherever they are declared. |
| P1.7 | Shadows whose colour is `var(--hue)` keep the colour at the use site and tokenise **geometry only** (`--shadow-composer-focus-spread`, `--tab-active-rule-w`, `--shadow-handle-glow-*`). | A custom property resolves where it is declared; hoisting `var(--hue)` into `:root` would freeze it at the root and lose per-provider hue on `[data-provider]` descendants. |
| P1.8 | Verification bar was **pixel-exact** (`maxDiffPixels: 0` across all 66 snapshots), stricter than the suite's 0.1% default. | The contract was "zero visual change"; a ratio tolerance could hide a changed corner. |
| P1.5 | Icon stroke is retargeted by attribute-qualified CSS (`.cu-icon[stroke-width="1.7"]`), not by changing React props. | Only the wrapper's defaults change; icons whose callers set their own stroke keep it, so the soft look is pixel-identical. |

## Phase 2 — theme infrastructure

| # | Decision | Why |
|---|---|---|
| P2.1 | The theme id is **derived, never stored**: `readThemeId()` = the manifest naming the stored look × palette pair, else `custom`. Look lives in `conduit:v10-look`; the palette keeps its existing key `conduit:v9-palette`. | No migration needed (existing palette choices map straight to their theme), no third key to drift, and `applyBrand.clearBrand()` keeps restoring the palette exactly as before. |
| P2.2 | Mode narrowing lives in `resolveTheme()`: when the active palette can't render the wanted mode it resolves to a supported one, without writing `AppSettings.theme`. App re-resolves on `conduit:theme-changed`. | One chokepoint that brand application, App and the pre-paint path already call. The user's saved mode returns as soon as they pick a two-mode theme. |
| P2.3 | Writers (`writePalette`, `selectTheme`) **don't overwrite `data-palette="brand"`** while a brand is active; they still persist. `applyUiPrefs()` stays unconditional. | Implements S6 (brand locks the palette). Boot still needs the unconditional apply so a cached brand that was removed on the Rust side gets cleared. |
| P2.4 | Mermaid and the HTML-artifact iframe get a per-manifest `native` \| `tokens` switch; the three existing themes stay `native`. Token-driven rendering lands with the first theme that needs it (Phase 3). | Keeps the existing looks pixel-stable; nothing would exercise `tokens` until Amber Terminal exists. |
| P2.5 | The old "Theme" select became **Mode** and "Theme" now names the picker, in every locale (the existing per-locale word moved with the concept). | Theme = look + palette is the user-facing concept; dark/light is a mode of it. |
| P2.6 | Tauri window `setBackgroundColor` per theme was **not** added. | It needs a new window capability permission (ADR-008 keeps that surface minimal) to fix a resize-edge flash only visible on the black theme. Revisit if the flash proves noticeable. |

## Phase 3 — Amber Terminal

| # | Decision | Why |
|---|---|---|
| P3.1 | Palette `amber` lives in tokens.css; look `terminal` in `packages/ui/src/looks/terminal.css`, imported by main.tsx after tokens.css. | Keeps tokenContrast a single-file parser; the look sheet wins ties with palette and CJK-locale blocks by source order. |
| P3.2 | Three AA deltas from OpenTerminal's values: `--ink-3` #808080 → #878787, an added middle ink #a6a6a6, `--on-hue` black (white on amber is 2.14:1). OpenTerminal has no warn/link colours; its chart series supply them. | Conduit's contrast floor is test-enforced on every surface. |
| P3.3 | **No font-token refactor.** `--font-ui/--font-mono/--font-serif` stay the brand-overridable roles (brand_emit.rs writes them). `--face-sans/--face-serif` restate the stacks in `:root` and each CJK block so the Reading font can reach the originals under a look that repoints the roles. | Renaming the roles would break Mode B brand emission and G8 guards for no user-visible gain. |
| P3.4 | Reading font rules use `html:root[data-reading-font]` (0,2,1) in chat.css. | Must beat both look and palette (0,1,1) regardless of sheet order. |
| P3.5 | Elevation is flattened with `0 0 transparent`, not `none`. | Several rules compose shadows (`var(--soft-lift), 0 0 0 …`); `none` inside a list invalidates the whole declaration. |
| P3.6 | Turn role labels are a `data-role-label` attribute (localised by React) rendered via `attr()` only under the terminal look. | No English in CSS `content`; zero DOM or visual change for other looks. |
| P3.7 | Value flash = remount a `.value-flash` span when a status-line figure changes (skipping first mount); the keyframes exist only in the terminal sheet. | No per-theme JS branch; reduced-motion already collapses animation durations globally. |
| P3.8 | Mermaid (`theme: 'base'` + themeVariables) and the artifact iframe stylesheet are built from `getComputedStyle` tokens **validated as strict hex / a conservative font-stack grammar**; any failure falls back to native. Soft themes stay `native`. | Values are interpolated into a config and a srcdoc stylesheet — same never-string-build-unvalidated-CSS rule as applyBrand.ts. |
| P3.9 | Single-mode themes disable the Mode control in Settings and onboarding and the header toggle (App `modeLocked`), with a "dark only" hint. | A toggle that silently does nothing reads as a bug. |
| P3.10 | OpenTerminal credit went into the hand-maintained `NOTICE` ("Design credits — adapted, no code copied", MIT text). | THIRD-PARTY-NOTICES.md is cargo-about generated (Rust crates only). |
| P3.11 | The visual matrix is generated from `THEMES × modes`; soft themes keep palette-only snapshot names. | Every future theme is snapshotted without editing the spec; existing baselines stay valid. |

## Phase 4 — more themes

| # | Decision | Why |
|---|---|---|
| P4.1 | Shipped five themes: **Green Phosphor** (terminal × phosphor, dark), **Amber Paper** (terminal × paper, light), **Graphite** (soft × graphite), **Editorial** (new `editorial` look × newsprint), **High Contrast** (new `contrast` look × contrast palette, AAA). | Covers every axis: new palettes on an existing look, a single-light-mode theme, and two genuinely structural looks (reading-first and accessibility-first), so "design themes" is proven beyond colour swaps. |
| P4.2 | **Glass** (Tauri window vibrancy/mica) deferred. | Needs `transparent` windows and window-effect permissions per OS, is untestable in `dev:web`/the visual suite, and carries per-platform performance risk. Revisit as its own change. |
| P4.3 | Single-mode palettes may be **light-only**; `modesForPalette` returns the union of manifest modes; tokenContrast checks a light-only palette on the light stack. Every Mode UI (Settings, onboarding, header toggle, theme badges) speaks "dark only" / "light only". | Amber Paper is the light companion S4 promised without making Amber Terminal two-mode. |
| P4.4 | `contrast` palette is held to **AAA (7:1)** for text tokens and ≥3:1 for `--line`; the `contrast` look adds 2px boundaries, 3px focus, +1px type, underlined links, no colour-only state, solid caret, `forced-colors` support. | An accessibility theme that only meets the product's baseline AA would not earn its name. |
| P4.5 | The "High Contrast" theme **name is localised** (OS accessibility term per locale); every other theme name stays English. | Users look for the OS term in their own language; recorded in i18n/glossary.md. |
| P4.6 | Editorial overlays keep a soft lift tinted by `--shadow-color`, not `--ink`. | Ink is light in dark mode; an ink-tinted shadow read as a glow (caught in Chrome review). |
| P4.7 | **Fixed a Phase 0 test bug**: the visual suite's light-mode pin read `document.documentElement` before it existed, threw, and never pinned — every "light" snapshot was actually dark. Light baselines were regenerated. Light mode was re-verified pixel-exact: Phase 0 → Phase 3 in a worktree (only intended Settings/onboarding changes), Phase 3 → Phase 4 in the main checkout (same). | Honest record: the Phase 1 "pixel-exact" claim originally covered dark mode only. Phase 1 changed structure, not colour, and the later cross-check confirms no light regression. |
| P4.8 | docs/theming/README.md is the authoring guide (model, contracts, specificity, how to add a palette/look/theme). | New themes should not need this session's context. |

## Phase 5 — user theme files

| # | Decision | Why |
|---|---|---|
| P5.1 | Format: `<appData>/themes/<id>.theme.md`, `+++` TOML frontmatter like brand.md; schema (`UserTheme` et al.) is Rust-canonical and ts-rs exported; parser reuses brand.rs's frontmatter splitter, hex validator and unquoted-hex hint. No new crates. | One authoring convention for brands and themes; cargo-deny stays untouched. |
| P5.2 | A theme **extends a built-in theme** and may override the 18 brand palette keys per mode and seven structural enums (corners, uiFont, readingFont, labels, shadows, motion, iconStroke). Everything else (syntax colours, code, shade, look-specific rules) comes from the base. | Small, fill-in-able surface (the same argument as the 18-key brand palette); a base guarantees a complete, contrast-tested remainder. |
| P5.3 | **Structure is enums only**, mapped by a fixed renderer table to token values; every lookup is own-key guarded. No raw CSS, no font names, no URLs. Values reach the DOM only via `style.setProperty` on allowlisted properties. | Same containment as applyBrand.ts: theme data can never become CSS syntax or a network request, regardless of CSP (`style-src 'unsafe-inline'`). |
| P5.4 | Palette hex is **`#rgb`/`#rrggbb` only** (no alpha), stricter than brands. | A user palette sits on another theme's structure; translucent surfaces can't be contrast-reasoned. |
| P5.5 | `deny_unknown_fields` on user-theme tables (brand.md is lenient). | Hand-authored files: a typo like `corner =` should fail loudly, not silently do nothing. |
| P5.6 | Loader limits: file name grammar `[a-z0-9][a-z0-9-]{0,39}.theme.md`, regular files only (no symlinks/dirs), ≤32 KiB checked before and during the read, UTF-8, ≤32 files (plus one `_overflow` notice). Invalid files are **listed with their error**, not hidden. | Unattended scan of a user-writable folder; authors need to see why a file didn't load. |
| P5.7 | Three commands only — `list_user_themes`, `reveal_themes_dir` (hardcoded path, mirrors `reveal_artifacts_dir`), `create_example_user_theme` (write-once) — **no renderer-supplied paths**, no capability changes. No import dialog and no file watcher (a Reload button instead). | ADR-008: custom commands are renderer-reachable, so none accepts a path. A watcher would need a new crate. |
| P5.8 | Modes of a user theme = the palette modes it declares, else the base's. An active brand keeps its palette; the user theme's structure still applies (S6). The Reading font preference still beats a theme's `readingFont`. | Consistent with built-in themes and brands. |
| P5.9 | User palettes reuse the brand descendant-hue mechanism (`html[data-user-palette] [data-provider] { --hue: inherit … }`), ordered after the palette pins and before provider-colour-off. | Inline `--hue` on `<html>` can't reach `[data-provider]` descendants that the base palette pins. |
| P5.10 | Selection persists as `conduit:v10-user-theme` + a ≤16 KiB pre-paint cache, re-validated on read and at apply; App boot reconciles against Rust and falls back to the base theme (with a toast) if the file vanished or became invalid. | No flash of the wrong theme on launch; no stale theme replaying forever. |
| P5.11 | Not critical enough to pause for the user: the feature adds no capability, network access or new parser class beyond brand.md, and was reviewed (loader bounds, apply allowlist, prototype-key lookups hardened in review). | Per the run's instructions, only critical security issues were to be escalated. |
