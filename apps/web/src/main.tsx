import React from 'react';
import ReactDOM from 'react-dom/client';
// i18n must initialize BEFORE the root render so the first paint already
// carries the resolved locale. Side-effect import: ./i18n calls init() at
// module-eval time and applies <html lang> / <html dir>.
import './i18n';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the PWA service worker in production builds only. In dev the SW
// would aggressively cache the Vite asset URLs and fight HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Non-fatal — the app still works without the SW.
      // eslint-disable-next-line no-console
      console.warn('[nockta] service worker registration failed', err);
    });
  });
}
