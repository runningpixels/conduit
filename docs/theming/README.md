# Theming

How Conduit's themes work, and how to add one. Decisions and their reasons
are logged in [decisions.md](decisions.md). To write your own theme file
without touching code, see [user-themes.md](user-themes.md).

## The model

A **theme** is what a user picks in Settings → Appearance. It pairs two
independent attributes on `<html>`, plus a few behaviours CSS can't express:

| Axis | Attribute | Owns | Lives in |
|---|---|---|---|
| **Look** | `data-look` | Structure: font roles, type scale, radii, borders, elevation, motion, focus ring, icon stroke, scrollbars, and scoped structural rules | `packages/ui/src/looks/<id>.css` (`soft` is the `:root` default and has no sheet) |
| **Palette** | `data-palette` | Colour: surfaces, ink ramp, lines, status, accent (`--hue*`), code, links, syntax | `packages/ui/src/tokens.css` |
| Mode | `data-theme` | Dark / light (`AppSettings.theme`) | unchanged; a theme can narrow it |

Other document attributes keep working across every theme:
`data-provider` / `data-provider-colour` (accent per provider),
`data-density`, `data-reduce-motion`, `data-reading-font` and brands
(`data-palette="brand"` plus inline properties).

Themes are declared in `apps/desktop/src/themes/registry.ts`:

```ts
{
  id: 'amber-terminal',
  i18nKey: 'amberTerminal',      // settings.appearance.themes.<key>.name/.description
  look: 'terminal',
  palette: 'amber',
  modes: ['dark'],               // single-mode themes lock the Mode control
  swatches: [ground, surface, ink, accent],
  mermaid: 'tokens',             // 'native' = Mermaid's own dark/light theme
  iframe: 'tokens',              // artifact iframe stylesheet from resolved tokens
  inspiredBy: { name, url, license },   // optional credit
}
```

The selected theme is never stored. `readThemeId()` derives it from the stored
look (`conduit:v10-look`) and palette (`conduit:v9-palette`). Any look × palette
pair with no manifest shows as *Custom* (Appearance → Advanced).

### Shipped themes

| Theme | Look | Palette | Modes |
|---|---|---|---|
| Orange Charcoal (default) | soft | orange-charcoal | dark, light |
| Orange-Dark | soft | orange-dark | dark, light |
| Terra | soft | terra | dark, light |
| Amber Terminal | terminal | amber | dark |
| Green Phosphor | terminal | phosphor | dark |
| Amber Paper | terminal | paper | light |
| Graphite | soft | graphite | dark, light |
| Editorial | editorial | newsprint | dark, light |
| High Contrast | contrast | contrast | dark, light |

## The contracts (all test-enforced)

1. **Axes don't overlap** (`lookContract.test.ts`).
   - Palette blocks may declare colour tokens and their own private inputs
     (for example `--am-hue`). `--font-prose` is the one other token allowed.
   - Look sheets scope every selector under `html[data-look="<id>"]` and declare
     no colour tokens and no colour literals (use `var()`, `transparent`,
     `currentColor`). They contain no `url()`, `@import` or `@font-face`.
   - Because of this, any look renders under any palette.
2. **Contrast** (`tokenContrast.test.ts`, driven by `PALETTE_IDS × modes`).
   - Every text token passes AA (4.5:1) on every surface, graphics pass 3:1,
     and the ink ramp keeps visible steps.
   - A two-mode palette's light block must restate every colour its dark
     block declares.
   - `contrast` is held to AAA.
3. **No literal structure** (`tokenDiscipline.test.ts`). Stylesheets and inline
   React styles route font-size, border-radius, box-shadow and transition
   durations through tokens, so a look can retarget them. Exceptions live on
   an allowlist, each with a reason.
4. **Classes exist** (`cssContract.test.ts`). Every class a look sheet styles
   must be used by some component, with no orphan or dead rules.
5. **Visual** (`pnpm -C apps/desktop test:visual`, local only). Snapshots every
   registered theme × mode across the dev gallery and the main routes.

## Specificity, briefly

| Selector | Specificity |
|---|---|
| `:root` and per-sheet role-token blocks | (0,1,0) |
| `[data-theme="light"]` | (0,1,0) |
| `html[data-look=…]`, `html[data-palette=…]`, `html[lang^=…]` | (0,1,1) |
| `html[data-palette=…][data-theme="light"]` | (0,2,1) |
| `html:root[data-reading-font=…]` (reading-font override) | (0,2,1) |

- Look sheets load after `tokens.css` (imported in `main.tsx`), so a look wins
  ties with palette and locale blocks. The axes are orthogonal, so the only
  shared tokens are `--font-prose` and the elevation composites.
- A two-mode palette's dark block (0,1,1) outranks `[data-theme="light"]`.
  That is why its light block must restate every colour.

## Adding a palette

1. Add a block to `tokens.css` next to the existing presets. Copy `amber`
   (single mode) or `orange-charcoal` (two modes), including:
   - a header comment stating the intent and any AA nudges;
   - the private hue inputs (`--xx-hue`, `--xx-hue-text`, `--xx-hue-solid`,
     `--xx-hue-weak-solid`);
   - the pinned-hue rule
     `html[data-palette="id"][data-provider], html[data-palette="id"] [data-provider]`;
   - the matching line in the `@supports not (color-mix…)` fallback.
2. Add the id to `PALETTE_IDS` and a label to `PALETTE_OPTION_KEYS` in
   `AppearanceSection.tsx` (tsc fails if you forget).
3. Run `pnpm -C apps/desktop exec vitest run src/styles`. Nudge lightness only
   until contrast passes, and record each nudge in the header comment.

A light-only palette writes its light values in the base block. `resolveTheme()`
never lets it meet dark.

## Adding a look

1. Create `packages/ui/src/looks/<id>.css`. `terminal.css` is the reference:
   token overrides first, then scoped structural rules grouped and commented
   by surface.
2. Add the id to `LOOK_IDS`, import the sheet in `main.tsx`, and add
   `settings.appearance.look.options.<id>` to every catalog.
3. Retarget tokens before writing rules. The retargetable set is listed below.
   When a value you need is a literal in a component stylesheet, replace it
   with a token rather than overriding it; `tokenDiscipline.test.ts` will
   guide you.
4. Text in `content:` must come from an attribute that React localises (see
   `data-role-label`), never from English written in CSS.

Retargetable structural tokens:

| Group | Tokens |
|---|---|
| Font roles | `--font-ui`, `--font-mono`, `--font-serif`, `--font-prose`, `--font-label` (reach the original stacks via `--face-sans` / `--face-serif`) |
| Type scale | `--fs-3xs` … `--fs-hero`, plus role tokens such as `--fs-prose` and `--fs-bubble` (see each stylesheet's top `:root` block) |
| Line height | `--leading-*` |
| Measure | `--measure` |
| Radii | `--r-1` … `--r-4`, `--r-xs`, `--r-sm`, `--r`, `--r-lg`, `--r-xl`, `--r-pill`, `--r-round` |
| Elevation | `--lift`, `--soft-lift`, `--shadow`, `--elevation-*`, `--glow`, `--shadow-*`, `--glass-*` |
| Motion | `--tap`, `--duration-*`, `--dur-*`, `--ease-*` |
| Focus | `--ring-width`, `--ring-offset` |
| Icons | `--icon-stroke`, `--icon-cap`, `--icon-join` |
| Scrollbars | `--scrollbar-*` |
| Labels | `--label-case`, `--label-weight` |

When flattening elevation, use `0 0 transparent` rather than `none`. Shadows are
composed in lists, and `none` invalidates the whole list.

## Adding a theme

1. Add the palette and/or look, following the steps above.
2. Add a manifest to `THEMES` and `settings.appearance.themes.<key>.name` /
   `.description` to all eight catalogs (`scripts/i18n-status.mjs --accept`,
   `scripts/i18n-pseudo.mjs`).
3. Pick `mermaid` / `iframe`. Use `tokens` unless the palette is a soft-look
   palette that already renders well in Mermaid's native themes.
4. Credit the source in `inspiredBy` and `NOTICE` when you adapt someone
   else's design.
5. Verify:
   - `pnpm -C apps/desktop check`
   - `pnpm -C apps/desktop test`
   - `pnpm -C apps/desktop test:visual` (then `--update-snapshots` for the new
     theme, and confirm no other snapshot moved)
   - `pnpm -C apps/desktop test:layout` for overflow under mono or larger type

## Working on a theme visually

```sh
pnpm -C apps/desktop dev:web
# http://localhost:5173/?route=gallery          every surface, with fixtures
# http://localhost:5173/?route=gallery&section=chat
```

To preview a pairing without the UI, run this in the console, then reload:
`localStorage.setItem('conduit:v10-look','terminal');
localStorage.setItem('conduit:v9-palette','amber')`.
