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
