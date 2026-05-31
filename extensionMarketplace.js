'use strict';

/**
 * Extension marketplace — fetch catalog from graysoft.dev with static fallback.
 */
const https = require('https');
const http = require('http');

const STATIC_CATALOG = [
  {
    id: 'guide-essentials-pack',
    name: 'guIDE Essentials Pack',
    version: '1.0.0',
    description: 'Prettier, ESLint, Error Lens, Git blame, YAML LSP, REST client — built into guIDE',
    author: 'guIDE',
    category: 'builtin',
    rating: 5,
    downloadUrl: null,
    builtin: true,
  },
  {
    id: 'guide-theme-dark-plus',
    name: 'Dark+ Theme',
    version: '1.0.0',
    description: 'Enhanced dark theme for guIDE',
    author: 'guIDE Community',
    category: 'theme',
    rating: 4.5,
    downloadUrl: null,
  },
  {
    id: 'guide-snippets-js',
    name: 'JavaScript Snippets',
    version: '1.0.0',
    description: 'Common JavaScript and React snippets',
    author: 'guIDE Community',
    category: 'snippets',
    rating: 4.2,
    downloadUrl: null,
  },
  {
    id: 'guide-formatter-prettier',
    name: 'Prettier Formatter',
    version: '1.0.0',
    description: 'Format on save with Prettier defaults',
    author: 'guIDE Community',
    category: 'formatter',
    rating: 4.8,
    downloadUrl: null,
  },
];

function _fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

async function fetchCatalog() {
  const urls = [
    'https://graysoft.dev/api/extensions',
    'https://graysoft.dev/extensions',
  ];

  for (const url of urls) {
    try {
      const data = await _fetchJson(url);
      const extensions = Array.isArray(data) ? data : (data.extensions || data.items || []);
      if (extensions.length > 0) {
        return { success: true, source: url, extensions };
      }
    } catch (e) {
      console.warn(`[Marketplace] Failed to fetch ${url}: ${e.message}`);
    }
  }

  return { success: true, source: 'static', extensions: STATIC_CATALOG };
}

module.exports = { fetchCatalog, STATIC_CATALOG };
