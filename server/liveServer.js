/**
 * Live Server — Static file server with WebSocket live-reload
 * Serves the user's project files for browser preview.
 * No external deps beyond 'ws' (already a dependency).
 */
'use strict';

const http = require('http');
const path = require('path');
const net = require('net');
const fs = require('fs').promises;

let _server = null;
let _wss = null;
let _currentPort = null;
let _wsPort = null;
let _rootPath = null;

// ── MIME types ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.cjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ts':   'application/javascript; charset=utf-8',
  '.tsx':  'application/javascript; charset=utf-8',
  '.jsx':  'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.eot':  'application/vnd.ms-fontobject',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ogg':  'video/ogg',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.pdf':  'application/pdf',
  '.zip':  'application/zip',
  '.wasm': 'application/wasm',
  '.map':  'application/json',
};

function getMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Find an available port starting from `start`
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(start, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', () => {
      if (start >= 4100) return reject(new Error('No free port found between 4000-4100'));
      resolve(findFreePort(start + 1));
    });
  });
}

// Live-reload script injected into all HTML responses
function liveReloadScript(wsPort) {
  return `<script>
(function(){
  var ws=new WebSocket('ws://127.0.0.1:${wsPort}');
  ws.onmessage=function(e){if(e.data==='reload')location.reload();};
  ws.onclose=function(){setTimeout(function(){location.reload();},2000);};
})();
</script>`;
}

// Broadcast reload to all connected WebSocket clients
function notifyReload() {
  if (!_wss) return;
  _wss.clients.forEach(client => {
    try { if (client.readyState === 1) client.send('reload'); } catch {}
  });
}

/**
 * Start the live server
 * @param {string} rootPath - Directory to serve (usually the project root or a subfolder)
 * @returns {Promise<{success: boolean, port?: number, wsPort?: number, url?: string, error?: string}>}
 */
async function start(rootPath) {
  // Stop any existing server first
  await stop();

  if (!rootPath) {
    return { success: false, error: 'rootPath is required' };
  }

  try {
    // Resolve and ensure path exists
    const resolvedRoot = path.resolve(rootPath);
    try {
      await fs.access(resolvedRoot);
    } catch {
      return { success: false, error: `Directory not found: ${resolvedRoot}` };
    }

    _rootPath = resolvedRoot;

    // Find available ports (start from 4000 to not conflict with main app on 3000)
    const port = await findFreePort(4000);
    const wsPort = await findFreePort(port + 1);

    // WebSocket server for live reload
    const { WebSocketServer } = require('ws');
    _wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' });

    // HTTP server
    _server = http.createServer(async (req, res) => {
      let urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';

      // Sanitize path — prevent directory traversal
      try { urlPath = decodeURIComponent(urlPath); } catch {}
      urlPath = urlPath.replace(/\.\./g, '').replace(/\\/g, '/');

      const absPath = path.join(_rootPath, urlPath);
      if (!absPath.startsWith(_rootPath)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      try {
        let content = await fs.readFile(absPath);
        const ext = path.extname(absPath).toLowerCase();
        const mime = getMime(absPath);

        // Inject live-reload script into HTML files
        if (ext === '.html' || ext === '.htm') {
          let html = content.toString('utf8');
          const script = liveReloadScript(wsPort);
          html = html.includes('</body>')
            ? html.replace('</body>', script + '</body>')
            : html + script;
          content = Buffer.from(html, 'utf8');
        }

        res.writeHead(200, {
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store',
        });
        res.end(content);
      } catch {
        // SPA fallback — try serving index.html
        try {
          const indexPath = path.join(_rootPath, 'index.html');
          let html = (await fs.readFile(indexPath)).toString('utf8');
          const script = liveReloadScript(wsPort);
          html = html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(html);
        } catch {
          res.writeHead(404);
          res.end(`Not found: ${urlPath}`);
        }
      }
    });

    await new Promise((resolve, reject) => {
      _server.listen(port, '127.0.0.1', () => resolve());
      _server.on('error', reject);
    });

    _currentPort = port;
    _wsPort = wsPort;

    console.log(`[LiveServer] Started on http://127.0.0.1:${port}/ (WS: ${wsPort}, root: ${_rootPath})`);
    return { success: true, port, wsPort, url: `http://127.0.0.1:${port}/` };
  } catch (error) {
    console.error('[LiveServer] Start failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Stop the live server
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function stop() {
  try {
    if (_wss) {
      _wss.close();
      _wss = null;
    }
    if (_server) {
      await new Promise((resolve) => {
        _server.close(() => resolve());
        // Force close after 1s if not closed
        setTimeout(resolve, 1000);
      });
      _server = null;
    }
    _currentPort = null;
    _wsPort = null;
    _rootPath = null;
    console.log('[LiveServer] Stopped');
    return { success: true };
  } catch (error) {
    console.error('[LiveServer] Stop failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get current server status
 * @returns {{running: boolean, port: number|null, wsPort: number|null, rootPath: string|null, url: string|null}}
 */
function getStatus() {
  return {
    running: !!_server && !!_currentPort,
    port: _currentPort,
    wsPort: _wsPort,
    rootPath: _rootPath,
    url: _currentPort ? `http://127.0.0.1:${_currentPort}/` : null,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  notifyReload,
};
