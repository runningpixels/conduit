# Bundled fonts

Conduit bundles its fonts locally rather than loading them from a CDN — the
app's CSP (`tauri.conf.json` → `app.security.csp`) sets `font-src 'self'`, and
a local-first app should not make network requests to render its own UI.

Both families are licensed under the [SIL Open Font License 1.1][ofl], which
permits bundling and redistribution provided the license text ships alongside
the font files. Those texts are in this directory and must not be removed.

| Family | Files | License | Source |
|---|---|---|---|
| Geist / Geist Mono | `Geist-{Regular,Medium,SemiBold,Bold}.woff2`, `GeistMono-{Regular,Medium,SemiBold}.woff2` | OFL-1.1 — [`OFL-Geist.txt`](./OFL-Geist.txt) | [vercel/geist-font](https://github.com/vercel/geist-font) |
| Source Serif 4 | `SourceSerif4-{Regular,SemiBold,Italic,SemiBoldItalic}.woff2` | OFL-1.1 — [`OFL-SourceSerif4.txt`](./OFL-SourceSerif4.txt) | [adobe-fonts/source-serif](https://github.com/adobe-fonts/source-serif) |

The OFL's reciprocity clause applies to derivative *fonts*, not to software that
embeds them — bundling these in an AGPL-3.0 application is compatible. Note the
Reserved Font Name provision: a modified version of either family may not be
distributed under its original name.

## Adding or updating a font

1. Download the `.woff2` files and the upstream license text together.
2. Commit the license text into this directory and add a row above.
3. Declare the `@font-face` in `packages/ui/src/tokens.css`.
4. Record the change in the root `NOTICE`.

[ofl]: https://openfontlicense.org/
