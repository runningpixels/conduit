import React from 'react';
import ReactDOM from 'react-dom/client';
import '@conduit/ui/tokens.css';
import './styles.css';
import App from './App';
import { applyUiReadability, readUiDensity, readUiFontSize } from './workspace/readability';
import '@conduit/ui/looks/terminal.css';
import '@conduit/ui/looks/editorial.css';
import '@conduit/ui/looks/contrast.css';
import { applyLook, applyPalette, applyReadingFont, readLook, readPalette, readReadingFont } from './shell/uiPrefs';
import { applyCachedBrand } from './brand/applyBrand';
import { applyCachedUserTheme } from './themes/userThemes';
import { resolveTheme } from './theme';
import { I18nProvider, bootstrapI18n } from './i18n';
import { installDevLocaleSwitch, readDevLocalePreference } from './i18n/devLocale';

applyUiReadability(readUiFontSize(), readUiDensity());
/* Before first paint, not in App's boot effect with the other uiPrefs: that
 * effect runs after three awaited IPC calls, and the palette moves every
 * surface and the prose face. Applied there it would show a full frame of the
 * Conduit look on every launch. The rest of the prefs tint or animate, so they
 * can wait; this one repaints. */
applyPalette(readPalette());
/* The look moves structure (type, radii, borders) as much as the palette moves
 * colour, so it is applied pre-paint for the same reason. */
applyLook(readLook());
applyReadingFont(readReadingFont());
/* Theming Phase 5 (user theme files): same pre-paint replay as the palette
 * and look above, for whichever user theme (if any) `conduit:v10-user-theme`
 * names. Placed after the palette/look/reading-font replay so a user theme's
 * own structural overrides win the ones just applied, and before the cached
 * brand replay below: on the rare launch where both are cached, the brand
 * replay runs last and its `setProperty` calls win the same properties this
 * one may have just set, so brand still ends up owning the paint — App's
 * boot effect reconciles both against Rust in brand-then-user-theme order
 * (App.tsx), which is what keeps `isBrandActive()` accurate for the
 * post-boot steady state. There is no persisted mode this early either, so
 * this resolves 'system' exactly like the brand replay below does. */
applyCachedUserTheme(resolveTheme('system'));
/* Same reasoning, for a white-label brand: `get_brand_config` is IPC too, so
 * replay the last-known-good config from localStorage synchronously here, and
 * let App's boot effect reconcile against the authoritative Rust read once it
 * lands. There is no persisted theme mode available this early — that lives
 * in AppSettings, which is itself behind that same IPC call — so this resolves
 * 'system' the same way theme.ts does, matching the dark-unless-prefers-light
 * default the bare :root block already assumes before any data-theme
 * attribute is set. */
applyCachedBrand(resolveTheme('system'));

installDevLocaleSwitch();

/* Language is resolved and its catalog parsed *before* the first render, for
 * the same reason the palette and the cached brand are applied above: App's
 * boot effect runs after three awaited IPC calls, and a frame of the wrong
 * language is exactly as visible as a frame of the wrong colour.
 *
 * The await here is a dynamic `import()` of a JSON module already inside the
 * bundle — a microtask, not IPC, and not even that for English. What it reads
 * is the localStorage mirror of `AppSettings.language`; App reconciles that
 * against the authoritative Rust value once `get_settings` lands, which is
 * the same replay-then-reconcile shape `applyCachedBrand` uses.
 *
 * A dev override, when present, outranks the mirror and is pinned: it is the
 * only route to the pseudo-locale, so App must not reconcile it away. */
const devLocale = readDevLocalePreference();

void bootstrapI18n(devLocale ?? undefined).then(({ preference, messages }) => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider
        initialPreference={preference}
        initialMessages={messages}
        overridden={devLocale !== null}
      >
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
});
