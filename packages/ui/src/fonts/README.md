# Bundled fonts

Conduit bundles its fonts locally rather than loading them from a CDN — the
app's CSP (`tauri.conf.json` → `app.security.csp`) sets `font-src 'self'`, and
a local-first app should not make network requests to render its own UI.

Both families are licensed under the [SIL Open Font License 1.1][ofl], which
permits bundling and redistribution provided the license text ships alongside
the font files. Those texts are in this directory and must not be removed.

| Family | Files | License | Source |
|---|---|---|---|
| Schibsted Grotesk (interface and prose) | `SchibstedGrotesk-{Latin,LatinExt}-Variable.woff2`, `SchibstedGrotesk-{Latin,LatinExt}-Italic-Variable.woff2` | OFL-1.1 — [`OFL-SchibstedGrotesk.txt`](./OFL-SchibstedGrotesk.txt) | [schibsted/schibsted-grotesk](https://github.com/schibsted/schibsted-grotesk), via [`@fontsource-variable/schibsted-grotesk`](https://fontsource.org/fonts/schibsted-grotesk) 5.3.0 |
| JetBrains Mono (code, numbers, keys) | `JetBrainsMono-{Latin,LatinExt}-Variable.woff2` | OFL-1.1 — [`OFL-JetBrainsMono.txt`](./OFL-JetBrainsMono.txt) | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono), via [`@fontsource-variable/jetbrains-mono`](https://fontsource.org/fonts/jetbrains-mono) 5.3.0 |

Both are variable fonts (one file per subset covers every weight), split into
Latin and Latin Extended; `tokens.css` declares matching `unicode-range`s so the
Extended file loads only when a character needs it. CJK text falls back to the
platform's CJK faces (see the CJK blocks in `tokens.css`). The choice is recorded
in ADR-011.

The OFL's reciprocity clause applies to derivative *fonts*, not to software that
embeds them — bundling these in an AGPL-3.0 application is compatible. Neither family
declares a Reserved Font Name, so the subset builds may keep their names.

## Adding or updating a font

1. Download the `.woff2` files and the upstream license text together.
2. Commit the license text into this directory and add a row above.
3. Declare the `@font-face` in `packages/ui/src/tokens.css`.
4. Record the change in the root `NOTICE`.

[ofl]: https://openfontlicense.org/
