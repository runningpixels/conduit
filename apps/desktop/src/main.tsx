import React from 'react';
import ReactDOM from 'react-dom/client';
import '@conduit/ui/tokens.css';
import './styles.css';
import App from './App';
import { PresenterApp } from './slides/PresenterApp';
import { parsePresenterRoute } from './slides/presentCore';
import { QuickAskApp } from './quickAsk/QuickAskApp';
import { isQuickAskRoute } from './quickAsk/route';
import { applyUiReadability, readUiDensity, readUiFontSize } from './workspace/readability';
import { applyCachedBrand } from './brand/applyBrand';
import { installWindowResizeFlag } from './workspace/windowResizing';
import { applyCachedAccent } from './themes/accent';
import { resolveTheme } from './theme';
import { I18nProvider, bootstrapI18n } from './i18n';
import { installDevLocaleSwitch, readDevLocalePreference } from './i18n/devLocale';

/* Which shell this is: the Tauri app (it has window controls in the title bar)
 * or a plain browser. workspace.css keys the phone layout's title bar on it. */
document.documentElement.dataset.shell = '__TAURI_INTERNALS__' in window ? 'desktop' : 'web';
/* Transitions off while the window is resized, so the layout tracks the edge. */
installWindowResizeFlag();

applyUiReadability(readUiFontSize(), readUiDensity());
/* Before first paint, not in App's boot effect: that effect runs after several
 * awaited IPC calls, and a white-label brand moves every surface. `get_brand_config`
 * is IPC too, so replay the last-known-good config from localStorage synchronously here, and
 * let App's boot effect reconcile against the authoritative Rust read once it
 * lands. There is no persisted theme mode available this early — that lives
 * in AppSettings, which is itself behind that same IPC call — so this resolves
 * 'system' the same way theme.ts does, matching the dark-unless-prefers-light
 * default the bare :root block already assumes before any data-theme
 * attribute is set. */
/* The presenter window (`?presenter=<deckId>`) is always dark: it sits beside
 * a projected slide and must not glare. */
const presenterDeckId = parsePresenterRoute(window.location.search);
const bootTheme = presenterDeckId ? 'dark' : resolveTheme('system');
if (presenterDeckId) document.documentElement.setAttribute('data-theme', 'dark');
/* The quick-ask window (`?ask=1`): Home's ask box alone, light or dark as the
 * app is (QuickAskApp reads the setting; the system's until then). */
const quickAsk = !presenterDeckId && isQuickAskRoute(window.location.search);
if (quickAsk) {
  document.documentElement.dataset.window = 'ask';
  document.documentElement.setAttribute('data-theme', bootTheme);
}
applyCachedBrand(bootTheme);
/* The main colour (ADR-011) lives in AppSettings too; replay its cache the
 * same way. After the brand, so an active brand makes it stand down. */
applyCachedAccent(bootTheme);

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
        {presenterDeckId ? <PresenterApp deckId={presenterDeckId} /> : quickAsk ? <QuickAskApp /> : <App />}
      </I18nProvider>
    </React.StrictMode>,
  );
});
