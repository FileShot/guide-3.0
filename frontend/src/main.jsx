import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// ─── Fetch bridge ───────────────────────────────────────────────────
// Intercepts fetch('/api/...') calls and routes them through Electron IPC
// instead of HTTP. This avoids rewriting 110+ fetch() calls across the app.
// In non-Electron environments (dev server), falls through to real fetch.
const _originalFetch = window.fetch;
window.__nativeFetch = _originalFetch;
window.fetch = function(url, options) {
  // Only intercept /api/* URLs when running in Electron
  if (window.electronAPI?.apiFetch && typeof url === 'string' && url.startsWith('/api/')) {
    return window.electronAPI.apiFetch(url, {
      method: options?.method || 'GET',
      body: options?.body || null,
      headers: options?.headers || {},
    }).then(result => {
      const status = result?._status || 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(result),
        text: () => Promise.resolve(typeof result === 'string' ? result : JSON.stringify(result)),
      };
    }).catch((err) => {
      const status = err?.status || err?._status || 500;
      const body = err?.body ?? err?.message ?? String(err);
      return {
        ok: false,
        status,
        json: () => Promise.resolve(typeof body === 'object' ? body : { error: body }),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      };
    });
  }
  return _originalFetch.apply(this, arguments);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
