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
| P1.5 | Icon stroke is retargeted by attribute-qualified CSS (`.cu-icon[stroke-width="1.7"]`), not by changing React props. | Only the wrapper's defaults change; icons whose callers set their own stroke keep it, so the soft look is pixel-identical. |
