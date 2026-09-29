# ADR 011: One design language, two modes

## Status
Accepted — 2026-09-29. Supersedes the look × palette theme model described in
`docs/theming/` (four looks, nine palettes, user theme files).

## Decision
Conduit ships **one** design language in **two modes, dark and light** (plus
"Match system"). The looks (`soft`, `terminal`, `editorial`, `contrast`) and
the palettes (Terra, Orange Charcoal, Amber Terminal, Green Phosphor, …) are
removed. A user can change exactly one thing: the **main colour** (the accent),
separately per mode.

- **Accent.** Coral `#FF7A59` in dark, indigo `#4B4DED` in light. It marks
  primary actions, the active navigation item, focus, selection and the
  assistant's activity line. It does **not** follow the active provider.
- **Signal.** Ice blue `#7CC4FF` in dark, sky blue `#1F86E8` in light: running
  and in-progress state, and the far end of the activity line.
- **Provider colour** (Anthropic's terracotta, OpenAI's green, …) identifies a
  model and appears only where a model is named: the model picker dot and
  the Providers list. It never tints the chrome.
- **Type.** Schibsted Grotesk for the interface and for prose, JetBrains Mono
  for code, numbers and keys. Both OFL-1.1, bundled as variable woff2 (Latin
  and Latin Extended), so the CSP stays `font-src 'self'`. CJK text keeps
  falling back to the platform's CJK faces. There is no separate reading serif.

## Context
The theme system grew to 4 looks × 9 palettes, each palette redeclaring every
colour per mode, and a user theme format that extends any of them. Keeping it
correct needed its own class of tests (the "specificity trap" guard, per-palette
contrast suites, look/palette separation checks), and every new surface had to
be checked against 13 combinations. The combinations also diluted the product's
identity: screenshots of Conduit rarely looked like the same app.

A single design, drawn once in both modes, is cheaper to keep correct and gives
Conduit a recognisable look. Custom colour stays possible for people who want
it, as the one lever that cannot break contrast or structure.

## Token contract
Components read plain CSS custom properties from `packages/ui/src/tokens.css`.
The existing semantic names are kept where the role is the same, and new roles
are added:

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| Window | `--bg` | `#0B0D12` | `#F6F6F8` |
| Navigation rail | `--bg-rail` | `#07090D` | `#E2E4EA` |
| Side column, panels | `--bg-side` | `#10131A` | `#EFF0F4` |
| Card, composer | `--card` | `#11141B` | `#FFFFFF` |
| Raised / hover | `--card-hi` | `#161A23` | `#F1F2F5` |
| Hairline | `--line` | `#1C2130` | `#E1E3EA` |
| Control border | `--line-hi` | `#262C3C` | `#DADCE3` |
| Text | `--ink` / `--ink-2` / `--ink-3` | `#E8EAF0` / `#B8BECC` / `#8990A2` | `#16181D` / `#3A3F4A` / `#5F6573` |
| Accent | `--accent` | `#FF7A59` | `#4B4DED` |
| Text on accent | `--on-accent` | `#1A0B06` | `#FFFFFF` |
| Accent as text | `--accent-text` | `#FF9C82` | `#2A2AA8` |
| Signal | `--signal` / `--signal-text` | `#7CC4FF` / `#7CC4FF` | `#1F86E8` / `#1767B8` |
| Status | `--ok` / `--warn` / `--err` | `#7CFFB2` / `#FEBC2E` / `#FF9C82` | `#137A3A` / `#9A5300` / `#B4380F` |

`--hue` (and `--hue-text`, `--hue-solid`, `--hue-weak`, `--on-hue`), which used
to carry the provider's colour through the whole UI, now resolves to the
accent. Each provider's own colour is exposed as `--provider-hue` for the
places that name a model.

Every text/surface pair clears WCAG AA (4.5:1), graphics clear 3:1, and
`styles/tokenContrast.test.ts` measures them from the stylesheet.

## Consequences
- The theme picker becomes Dark / Light / Match system plus a main-colour
  control. Stored look and palette preferences migrate to the nearest mode.
- User theme files shrink to a main colour per mode. Older files that
  restyled structure or surfaces are read but not applied.
- White-label builds keep working through the curated brand token set. How a
  brand layers on the single design is decided separately.
- The migration lands in phases. Until the theme machinery is deleted, the
  renderer pins the old look/palette attributes to the base look so the
  removed palettes can never override the new tokens.
