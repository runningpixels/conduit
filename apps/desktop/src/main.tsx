import React from 'react';
import ReactDOM from 'react-dom/client';
import '@conduit/ui/tokens.css';
import './styles.css';
import App from './App';
import { applyUiReadability, readUiDensity, readUiFontSize } from './workspace/readability';
import { applyPalette, readPalette } from './shell/uiPrefs';

applyUiReadability(readUiFontSize(), readUiDensity());
/* Before first paint, not in App's boot effect with the other uiPrefs: that
 * effect runs after three awaited IPC calls, and the palette moves every
 * surface and the prose face. Applied there it would show a full frame of the
 * Conduit look on every launch. The rest of the prefs tint or animate, so they
 * can wait; this one repaints. */
applyPalette(readPalette());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
