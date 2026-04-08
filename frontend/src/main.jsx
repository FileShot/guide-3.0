import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// ─── Fetch bridge ───────────────────────────────────────────────────
// Intercepts fetch('/api/...') calls and routes them through Electron IPC
// instead of HTTP. This avoids rewriting 110+ fetch() calls across the app.
// In non-Electron environments (dev server), falls through to real fetch.
const _originalFetch = window.fetch;
window.fetch = function(url, options) {
  // Only intercept /api/* URLs when running in Electron
  if (window.electronAPI?.apiFetch && typeof url === 'string' && url.startsWith('/api/')) {
    return window.electronAPI.apiFetch(url, {
      method: options?.method || 'GET',
      body: options?.body || null,
      headers: options?.headers || {},
    }).then(result => {
      // Wrap the IPC result in a Response-like object so callers can do .json()
      const status = result?._status || 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(result),
        text: () => Promise.resolve(typeof result === 'string' ? result : JSON.stringify(result)),
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
