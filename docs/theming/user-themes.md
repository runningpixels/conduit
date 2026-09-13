# User theme files

Author-facing reference for `*.theme.md` -- theming Phase 5
(`docs/theming/decisions.md` S7). See `docs/theming/README.md` for the
underlying look/palette model these files sit on top of.

## Where the folder is

`<appDataLocal>/themes/`, a sibling of `branding/` (see
`apps/desktop/src-tauri/src/paths.rs`). Conduit creates it at startup if it
does not exist. Settings -> Appearance has "Reveal themes folder" (the
`reveal_themes_dir` command) to open it in the OS file manager, and "Add
example theme" (`create_example_user_theme`) to drop a fully-commented
starter file there without overwriting one you already have.

## File format

A `*.theme.md` file is `+++`-delimited TOML frontmatter followed by an
optional Markdown body, exactly like `brand.md` (see
`docs/branding/brand.template.md`):

```
+++
schemaVersion = 1
name = "My Theme"
extends = "graphite"
+++

Notes go here. Never parsed.
```

- The **file name** must match `^[a-z0-9][a-z0-9-]{0,39}\.theme\.md$`:
  lowercase letters, digits, and hyphens, starting with a letter or digit,
  1-40 characters before `.theme.md`. Anything else in the folder --
  wrong case, wrong suffix, a subdirectory, a symlink -- is silently
  ignored, not listed and not reported as an error.
- The **id** shown to the renderer is the file name with `.theme.md`
  stripped (`graphite-warm.theme.md` -> `graphite-warm`).
- The file is capped at **32 KiB**. Larger files are rejected with an
  error, not truncated.
- The `#` character starts a comment in TOML. A hex colour **must** be
  quoted (`hue = "#268bd2"`, never `hue = #268bd2`) or the value is silently
  discarded and the file fails to parse. The parser recognizes this mistake
  and names the offending line in its error.
- A `notes` key inside the frontmatter is rejected. Notes come only from the
  Markdown body, after the closing `+++`.
- At most **32** theme files are read per launch. Beyond that, the extra
  files are not loaded, and one synthetic entry (id `_overflow`) explains
  how many were skipped.

## Every key

| Key | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | integer | yes | Must be `1`. A different version is a hard error -- a half-understood theme is worse than none. |
| `name` | string | yes | 1-48 characters after trimming. No control characters. Shown in the theme picker. |
| `description` | string | no | Up to 160 characters. No control characters. Shown under the name. |
| `extends` | string | yes | Which built-in theme this one starts from. Grammar: `^[a-z0-9-]{1,40}$`. See "extends" below. |
| `[palette.dark]` / `[palette.light]` | table | no | Colour overrides. See "Palette" below. |
| `[structure]` | table | no | Structural overrides. See "Structure" below. |
| body (after `+++`) | Markdown | no | Free-form notes. Never parsed or rendered as HTML. Preserved verbatim. |

### `extends`

The id of the built-in theme this file starts from. Conduit ships:

`conduit-orange-charcoal`, `conduit-orange-dark`, `conduit-terra`,
`amber-terminal`, `green-phosphor`, `amber-paper`, `graphite`, `editorial`,
`high-contrast`.

The grammar (`[a-z0-9-]{1,40}`) is checked by the parser; whether the id
actually names a theme Conduit currently ships is checked by the renderer,
which owns the theme registry (`apps/desktop/src/themes/registry.ts`). An
`extends` value that parses but names nothing the renderer recognizes is
the renderer's error to surface, not the parser's -- the registry can grow
without a corresponding change here.

### Palette

Optional. Omit `[palette]` entirely (i.e. neither `[palette.dark]` nor
`[palette.light]`) to keep `extends`'s own colours untouched.

If you specify a palette at all, **at least one** of `[palette.dark]` /
`[palette.light]` is required -- an empty `[palette]` with neither table is
rejected, the same as a `[logo]` with no `file`. Each table you *do* specify
must set all eighteen keys below; there is no partial override of a single
mode's palette.

| Key | CSS token | Meaning |
|---|---|---|
| `bg` | `--bg` | App ground |
| `bgSide` | `--bg-side` | Sidebar / rail ground |
| `card` | `--card` | Raised surface (messages, panels) |
| `cardHi` | `--card-hi` | Hovered/active card |
| `line` | `--line` | Default border |
| `lineSoft` | `--line-soft` | Subdued divider |
| `lineHi` | `--line-hi` | Emphasised border |
| `ink` | `--ink` | Primary text |
| `ink2` | `--ink-2` | Secondary text |
| `ink3` | `--ink-3` | Tertiary text |
| `hue` | `--hue` | Accent |
| `hueText` | `--hue-text` | Accent tuned for text-on-background contrast |
| `hueSolid` | `--hue-solid` | Accent as a solid fill |
| `onHue` | `--on-hue` | Text drawn on top of `hueSolid` |
| `ok` | `--ok` | Success |
| `warn` | `--warn` | Warning |
| `err` | `--err` | Error |
| `link` | `--link` | Hyperlink |

Values are hex only: **`#rgb` or `#rrggbb`**. Unlike `brand.md`, an
8-digit `#rrggbbaa` alpha value is rejected. `brand.md`'s palette *is* the
app's whole colour system, so there is nothing behind a translucent value
for it to composite against; a user theme's palette sits on top of a base
theme (`extends`) it does not otherwise change, so a translucent surface
colour would composite unpredictably against whatever that base theme's
structure puts underneath it. Keeping user themes opaque-only sidesteps
that rather than trying to model it.

### Structure

Optional. Every key defaults to `extends`'s own choice when omitted. Each
is a closed enum the renderer maps to token values -- a theme file can
never express a raw CSS value, so it can never reach the network or escape
a declaration regardless of what the CSP otherwise allows.

| Key | Values | CSS token(s) it retargets |
|---|---|---|
| `corners` | `square`, `subtle`, `rounded`, `soft` | `--r-*` radii |
| `uiFont` | `sans`, `serif`, `mono` | `--font-ui` |
| `readingFont` | `sans`, `serif`, `mono` | Assistant-prose "Reading font" override |
| `labels` | `plain`, `uppercase`, `small-caps` | `--label-case` / `--label-weight` |
| `shadows` | `none`, `soft` | Elevation (`--lift`, `--shadow*`) |
| `motion` | `none`, `standard` | Transition durations |
| `iconStroke` | `thin`, `regular`, `bold` | `--icon-stroke` |

## What overrides what

- **Modes.** The mode(s) present in `[palette]` become this theme's modes:
  specify only `[palette.dark]` and the theme is dark-only (the Mode
  control locks, same as a built-in single-mode theme); specify both and
  it is a two-mode theme. Specify no `[palette]` at all and the theme
  inherits `extends`'s own modes.
- **Structure.** Every `[structure]` key is independent. An omitted key
  keeps `extends`'s value for that one thing; there is no "all or nothing"
  rule the way there is for a palette mode's eighteen colours.
- **Everything else.** A user theme changes only what it names. It never
  affects settings, providers, or data -- it is presentation-only.

## Brand interaction

An active brand (`brand.md`) locks the palette (S6 in
`docs/theming/decisions.md`): while a brand is applied, its colours win
regardless of what a user theme's `[palette]` says. Structure still
applies -- a user theme's `[structure]` choices (corners, fonts, motion,
etc.) are independent of colour and continue to retarget the UI even with a
brand active.

## Limits, summarized

| Limit | Value |
|---|---|
| Max file size | 32 KiB (`MAX_USER_THEME_BYTES`) |
| Max files read per launch | 32, plus one summary entry for the rest |
| File name grammar | `^[a-z0-9][a-z0-9-]{0,39}\.theme\.md$` |
| `name` length | 1-48 characters, trimmed, no control characters |
| `description` length | up to 160 characters, no control characters |
| `extends` grammar | `^[a-z0-9-]{1,40}$` |
| Palette hex forms | `#rgb`, `#rrggbb` only (no 8-digit alpha) |
| Palette completeness | each specified mode table sets all 18 keys |

## Commands

| Command | Returns | Notes |
|---|---|---|
| `list_user_themes` | `UserThemeEntry[]` | Every file in the themes folder, valid or not. An invalid file comes back with `theme: null, error: "..."` rather than being omitted, so the picker can show the author what to fix. |
| `reveal_themes_dir` | `void` | Opens the themes folder in the OS file manager. No arguments -- the path is server-owned. |
| `create_example_user_theme` | `string` (theme id) | Writes the bundled template to `example.theme.md` the first time it is called. Never overwrites; if the file already exists, returns `"example"` without touching it. |

No command accepts a renderer-supplied path or file name.
