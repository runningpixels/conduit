import React from 'react';
import ReactDOM from 'react-dom/client';
import '@conduit/ui/tokens.css';
import './styles.css';
import App from './App';
import { applyUiReadability, readUiDensity, readUiFontSize } from './workspace/readability';

applyUiReadability(readUiFontSize(), readUiDensity());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
