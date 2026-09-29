# Theming (retired)

The look × palette theme system this folder documented — four looks, nine
palettes and user theme files — was retired by
[ADR-011](../adr/adr-011-single-design-language.md): Conduit ships one design
language in two modes (dark and light), and a user can change only the main
colour, per mode, in Settings → Appearance.

Where things live now:

- **Tokens:** `packages/ui/src/tokens.css` — `:root` is dark, `[data-theme="light"]`
  is light. `apps/desktop/src/styles/tokenContrast.test.ts` measures every
  text and surface pair.
- **Main colour:** `AppSettings.accent`, derived and applied by
  `apps/desktop/src/themes/accent.ts`.
- **White-label brands** still override the curated brand token set; see
  `docs/branding/`.

[decisions.md](decisions.md) is kept as the record of how the theme system was
built and why, for anyone revisiting that ground.
