import React from 'react';
import ReactDOM from 'react-dom/client';
import '@conduit/ui/tokens.css';
import './styles.css';
import App from './App';
import { applyUiReadability, readUiDensity, readUiFontSize } from './workspace/readability';
import { applyPalette, readPalette } from './shell/uiPrefs';
import { applyCachedBrand } from './brand/applyBrand';
import { resolveTheme } from './theme';

applyUiReadability(readUiFontSize(), readUiDensity());
/* Before first paint, not in App's boot effect with the other uiPrefs: that
 * effect runs after three awaited IPC calls, and the palette moves every
 * surface and the prose face. Applied there it would show a full frame of the
 * Conduit look on every launch. The rest of the prefs tint or animate, so they
 * can wait; this one repaints. */
applyPalette(readPalette());
/* Same reasoning, for a white-label brand: `get_brand_config` is IPC too, so
 * replay the last-known-good config from localStorage synchronously here, and
 * let App's boot effect reconcile against the authoritative Rust read once it
 * lands. There is no persisted theme mode available this early — that lives
 * in AppSettings, which is itself behind that same IPC call — so this resolves
 * 'system' the same way theme.ts does, matching the dark-unless-prefers-light
 * default the bare :root block already assumes before any data-theme
 * attribute is set. */
applyCachedBrand(resolveTheme('system'));

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
